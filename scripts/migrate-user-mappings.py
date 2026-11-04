"""Offline, scoped identity/data association. Never copies account credentials."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile


def require(condition):
    if not condition:
        raise ValueError('USER_MAPPING_CHECK_FAILED')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def ordinary(path, root):
    require(path.resolve() == path and path.is_relative_to(root))
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
    return info


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def atomic(path, data, uid=1000, gid=1000, mode=0o600):
    missing = []
    current = path.parent
    while not current.exists():
        missing.append(current)
        current = current.parent
    require(current.resolve() == current)
    for directory in reversed(missing):
        directory.mkdir(mode=0o700)
        if os.geteuid() == 0:
            os.chown(directory, uid, gid)
    handle, temporary = tempfile.mkstemp(prefix='.qqbot-association-', dir=path.parent)
    try:
        with os.fdopen(handle, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        if os.geteuid() == 0:
            os.chown(temporary, uid, gid)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def records(path, root, uid):
    if not path.exists():
        return [], None, None
    info = ordinary(path, root)
    raw = path.read_bytes()
    values = json.loads(raw)
    require(isinstance(values, list))
    for item in values:
        require(isinstance(item, dict) and str(item.get('uid', '')) == uid)
        require(re.fullmatch(r'[0-9]{1,64}', str(item.get('id', ''))) is not None)
    return values, raw, info


def stokens(path, root, owner, bindings):
    if not path.exists():
        return {}, None, None
    info = ordinary(path, root)
    raw = path.read_bytes()
    try:
        import yaml
        values = yaml.safe_load(raw)
    except ModuleNotFoundError:
        values = json.loads(raw)
    require(isinstance(values, dict))
    if values.get('uid'):
        values = {str(values['uid']): values}
    normalized = {}
    for key, value in values.items():
        key = str(key)
        require(re.fullmatch(r'[0-9]{1,20}', key) is not None and isinstance(value, dict))
        require(str(value.get('uid', '')) == key and str(value.get('stuid', '')) in bindings)
        require(str(value.get('userId', owner)) == owner)
        normalized[key] = value
    return normalized, raw, info


def audit(root):
    root = Path(root).absolute()
    require(root.resolve() == root)
    account = root / 'plugins/qqbot-adapter-plugin/private/account.json'
    account_info = ordinary(account, root)
    raw = account.read_bytes()
    document = json.loads(raw)
    app = document['config']['appId']
    require(isinstance(app, str) and re.fullmatch(r'[0-9]{1,32}', app) is not None)
    before = document['config'].get('userIdMappings', {})
    require(isinstance(before, dict))
    mappings = dict(before)
    pattern = re.compile(r'qqbot:([0-9]{1,32}):(group-user|c2c-user):([A-Za-z0-9_-]{1,128})')
    targets = {}
    for principal, qq in mappings.items():
        match = pattern.fullmatch(principal)
        require(match is not None and isinstance(qq, str) and re.fullmatch(r'[1-9][0-9]{4,11}', qq) is not None)
        key = (match[1], match[2], qq)
        require(key not in targets)
        targets[key] = principal
    database = root / 'data/db/data.db'
    ordinary(database, root)
    rows = []
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
        for owner, owner_type, bindings, games in connection.execute('select id,type,ltuids,games from Users'):
            if owner_type != 'qq':
                continue
            games = json.loads(games) if games else {}
            require(isinstance(games, dict))
            uids = {key: str(value.get('uid')) for key, value in games.items() if isinstance(value, dict) and value.get('uid')}
            rows.append((str(owner), frozenset(v.strip() for v in str(bindings or '').split(',') if v.strip()), uids))
    legacy = [row for row in rows if re.fullmatch(r'[1-9][0-9]{4,11}', row[0]) and row[1]]
    candidates = []
    report = dict(officialUsers=0, verifiedAssociations=0, mappingsAdded=0, unmatched=0, ambiguous=0, filesChanged=0, newRecordsAdded=0, oldRecordsRetained=0, credentialFilesUpdated=0)
    for row in rows:
        match = pattern.fullmatch(row[0])
        if not match or match[1] != app:
            continue
        report['officialUsers'] += 1
        matches = [old for old in legacy if row[1] and row[1] == old[1] and row[2] and row[2] == old[2]]
        if len(matches) != 1:
            report['ambiguous' if len(matches) > 1 else 'unmatched'] += 1
            continue
        candidates.append((row[0], matches[0][0], match[2]))
    selected = []
    for principal, qq, kind in candidates:
        if sum(other_qq == qq and other_kind == kind for _, other_qq, other_kind in candidates) != 1:
            report['ambiguous'] += 1
            continue
        key = (app, kind, qq)
        if key in targets and targets[key] != principal:
            report['ambiguous'] += 1
            continue
        require(principal not in mappings or mappings[principal] == qq)
        report['mappingsAdded'] += int(principal not in mappings)
        mappings[principal] = qq
        targets[key] = principal
        selected.append((principal, qq))
    require(len(mappings) <= 1000)
    report['verifiedAssociations'] = len(selected)
    changes = {}
    credential_states = {}
    bindings_by_id = {row[0]: row[1] for row in rows}
    for principal, qq in selected:
        for area in ['gachaJson', 'srJson']:
            source = root / 'data' / area / principal
            if not source.exists():
                continue
            require(source.resolve() == source and source.is_dir())
            for file in source.rglob('*.json'):
                relative = file.relative_to(source)
                require(len(relative.parts) == 2 and re.fullmatch(r'[0-9]{1,20}', relative.parts[0]) is not None and re.fullmatch(r'[0-9]{1,5}\.json', relative.parts[1]) is not None)
                target = root / 'data' / area / qq / relative
                require(target.resolve() == target)
                incoming, _, _ = records(file, root, relative.parts[0])
                key = str(target.relative_to(root))
                if key not in changes:
                    original, data, info = records(target, root, relative.parts[0])
                    changes[key] = dict(path=target, before=data, info=info, records=list(original), ids={str(item['id']) for item in original}, added=0)
                entry = changes[key]
                for item in incoming:
                    if str(item['id']) not in entry['ids']:
                        entry['records'].append(item)
                        entry['ids'].add(str(item['id']))
                        entry['added'] += 1
        folder = root / 'plugins/xiaoyao-cvs-plugin/data/yaml'
        incoming_tokens, _, source_token_info = stokens(folder / (principal + '.yaml'), root, principal, bindings_by_id[principal])
        existing_tokens, token_bytes, token_info = stokens(folder / (qq + '.yaml'), root, qq, bindings_by_id[principal])
        target = folder / (qq + '.yaml')
        key = str(target.relative_to(root))
        if key not in credential_states:
            credential_states[key] = dict(path=target, relative=key, before=token_bytes, info=token_info, original=existing_tokens, merged=dict(existing_tokens), times={uid: token_info.st_mtime_ns for uid in existing_tokens}, credential=True)
        state = credential_states[key]
        for uid, value in incoming_tokens.items():
            previous = state['merged'].get(uid, {})
            if previous and source_token_info.st_mtime_ns <= state['times'][uid]:
                continue
            merged = dict(previous)
            merged.update(value)
            merged['userId'] = qq
            original = state['original'].get(uid, {})
            if 'is_sign' in original:
                merged['is_sign'] = original['is_sign']
            state['merged'][uid] = merged
            state['times'][uid] = source_token_info.st_mtime_ns
    credential_changes = []
    for state in credential_states.values():
        if state['merged'] != state['original']:
            require(state['path'].resolve() == state['path'])
            state['after'] = encode(state['merged'])
            credential_changes.append(state)
    report['credentialFilesUpdated'] = len(credential_changes)
    planned = []
    for key, entry in changes.items():
        if not entry['added']:
            continue
        report['oldRecordsRetained'] += len(entry['records']) - entry['added']
        report['newRecordsAdded'] += entry['added']
        entry['records'].sort(key=lambda item: int(str(item['id'])), reverse=True)
        entry['after'] = encode(entry['records'])
        entry['relative'] = key
        planned.append(entry)
    planned.extend(credential_changes)
    report['filesChanged'] = len(planned)
    return dict(root=root, account=account, account_info=account_info, raw=raw, document=document, before=before, mappings=mappings, changes=planned, report=report)


def apply(root, rollback_directory):
    plan = audit(root)
    rollback_directory = Path(rollback_directory).absolute()
    require(rollback_directory.resolve() == rollback_directory and not rollback_directory.is_relative_to(plan['root']))
    rollback_directory.mkdir(mode=0o700)
    account = plan['account']
    document = plan['document']
    previous_mapping_present = 'userIdMappings' in document['config']
    journal = dict(mappingPresent=previous_mapping_present, mappingBefore=plan['before'], mappingAfter=plan['mappings'], files=[])
    for entry in plan['changes']:
        before = entry['before']
        if before is not None:
            backup = rollback_directory / 'data' / entry['relative']
            backup.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            backup.write_bytes(before)
            os.chmod(backup, 0o600)
        info = entry['info']
        mode = stat.S_IMODE(info.st_mode) if info else 0o600
        journal['files'].append(dict(relative=entry['relative'], before=digest(before) if before is not None else None, after=digest(entry['after']), uid=info.st_uid if info else 1000, gid=info.st_gid if info else 1000, mode=mode, writeMode=0o600 if entry.get('credential') else mode, atimeNs=info.st_atime_ns if info else None, mtimeNs=info.st_mtime_ns if info else None))
    (rollback_directory / 'journal.json').write_bytes(encode(journal))
    applied = []
    config_written = False
    try:
        require(account.read_bytes() == plan['raw'])
        for entry, metadata in zip(plan['changes'], journal['files']):
            target = entry['path']
            require((target.read_bytes() if target.exists() else None) == entry['before'])
            atomic(target, entry['after'], metadata['uid'], metadata['gid'], metadata['writeMode'])
            applied.append((entry, metadata))
        document['config']['userIdMappings'] = plan['mappings']
        info = plan['account_info']
        atomic(account, encode(document), info.st_uid, info.st_gid, 0o600)
        config_written = True
        after = json.loads(account.read_bytes())
        before_document = json.loads(plan['raw'])
        require(after.get('appSecret') == before_document.get('appSecret'))
        a = dict(after['config']); b = dict(before_document['config'])
        a.pop('userIdMappings', None); b.pop('userIdMappings', None)
        require(a == b)
        for entry in plan['changes']:
            require(entry['path'].read_bytes() == entry['after'])
    except Exception:
        for entry, metadata in reversed(applied):
            if entry['before'] is None:
                entry['path'].unlink()
            else:
                atomic(entry['path'], entry['before'], metadata['uid'], metadata['gid'], metadata['mode'])
                os.utime(entry['path'], ns=(metadata['atimeNs'], metadata['mtimeNs']))
        if config_written:
            info = plan['account_info']
            atomic(account, plan['raw'], info.st_uid, info.st_gid, 0o600)
        raise
    return dict(plan['report'], privateCredentialsPreserved=True, unrelatedConfigPreserved=True)


def rollback(root, rollback_directory):
    root = Path(root).absolute(); rollback_directory = Path(rollback_directory).absolute()
    require(root.resolve() == root and rollback_directory.resolve() == rollback_directory)
    journal = json.loads((rollback_directory / 'journal.json').read_bytes())
    account = root / 'plugins/qqbot-adapter-plugin/private/account.json'
    info = ordinary(account, root)
    document = json.loads(account.read_bytes())
    require(document['config'].get('userIdMappings', {}) == journal['mappingAfter'])
    for entry in journal['files']:
        target = root / entry['relative']
        ordinary(target, root)
        require(digest(target.read_bytes()) == entry['after'])
        if entry['before'] is not None:
            backup = rollback_directory / 'data' / entry['relative']
            require(digest(backup.read_bytes()) == entry['before'])
    for entry in reversed(journal['files']):
        target = root / entry['relative']
        if entry['before'] is None:
            target.unlink()
        else:
            atomic(target, (rollback_directory / 'data' / entry['relative']).read_bytes(), entry['uid'], entry['gid'], entry['mode'])
            os.utime(target, ns=(entry['atimeNs'], entry['mtimeNs']))
    if journal['mappingPresent']:
        document['config']['userIdMappings'] = journal['mappingBefore']
    else:
        document['config'].pop('userIdMappings', None)
    atomic(account, encode(document), info.st_uid, info.st_gid, 0o600)
    return dict(mappingRollback=True, restoredFiles=len(journal['files']))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--rollback-dir')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    try:
        require(not (args.apply and args.rollback))
        if args.apply or args.rollback:
            require(args.offline and args.rollback_dir is not None)
            report = (apply if args.apply else rollback)(args.root, args.rollback_dir)
        else:
            report = audit(args.root)['report']
        print(json.dumps(report))
    except Exception:
        print(json.dumps(dict(error='USER_MAPPING_MIGRATION_FAILED')))
        raise SystemExit(1)
