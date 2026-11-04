import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('migration', Path(__file__).parent.parent / 'scripts/migrate-user-mappings.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='qqbot-mapping-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / 'source'
        self.account = self.root / 'plugins/qqbot-adapter-plugin/private/account.json'
        self.account.parent.mkdir(parents=True)
        self.account.write_text(json.dumps({'version': 1, 'appSecret': 'FAKE_SECRET', 'config': {'appId': '123456', 'enabled': True}}))
        self.database = self.root / 'data/db/data.db'
        self.database.parent.mkdir(parents=True)
        self.db = sqlite3.connect(self.database)
        self.addCleanup(self.db.close)
        self.db.execute('create table Users(id text, type text, ltuids text, games text)')
        self.principal = 'qqbot:123456:group-user:verified'
        self.user('10001', '555', '109000001')
        self.user(self.principal, '555', '109000001')
        self.user('qqbot:123456:group-user:claim', None, '109000001')
        self.old = self.file('10001', [{'uid': '109000001', 'id': '10', 'name': 'old-10'}, {'uid': '109000001', 'id': '9', 'name': 'old-9'}])
        self.new = self.file(self.principal, [{'uid': '109000001', 'id': '11', 'name': 'new-11'}, {'uid': '109000001', 'id': '10', 'name': 'new-copy'}])
        folder = self.root / 'plugins/xiaoyao-cvs-plugin/data/yaml'; folder.mkdir(parents=True)
        self.old_token = folder / '10001.yaml'; self.new_token = folder / (self.principal + '.yaml')
        self.old_token.write_text(json.dumps({'109000001': {'uid': '109000001', 'stuid': '555', 'userId': '10001', 'stoken': 'FAKE_OLD_TOKEN', 'is_sign': False}, '109000002': {'uid': '109000002', 'stuid': '555', 'userId': '10001', 'stoken': 'FAKE_EXTRA_TOKEN'}}))
        self.new_token.write_text(json.dumps({'109000001': {'uid': '109000001', 'stuid': '555', 'userId': self.principal, 'stoken': 'FAKE_NEW_TOKEN', 'is_sign': True}}))
        os.utime(self.old_token, ns=(1000000000, 1000000000)); os.utime(self.new_token, ns=(2000000000, 2000000000))

    def user(self, identity, bindings, uid):
        self.db.execute('insert into Users values(?,?,?,?)', (identity, 'qq', bindings, json.dumps({'gs': {'uid': uid}})))
        self.db.commit()

    def file(self, owner, values):
        path = self.root / 'data/gachaJson' / owner / '109000001/301.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(values))
        return path

    def test_audit_is_readonly_and_uid_claims_never_associate(self):
        before = self.account.read_bytes(), self.old.read_bytes(), self.new.read_bytes()
        plan = migration.audit(self.root)
        self.assertEqual(plan['mappings'], {self.principal: '10001'})
        self.assertEqual(plan['report']['newRecordsAdded'], 1)
        self.assertEqual(before, (self.account.read_bytes(), self.old.read_bytes(), self.new.read_bytes()))

    def test_apply_preserves_every_old_record_source_and_credentials_and_rolls_back(self):
        old_bytes, source_bytes = self.old.read_bytes(), self.new.read_bytes()
        token_bytes, new_token_bytes = self.old_token.read_bytes(), self.new_token.read_bytes()
        backup = self.base / 'rollback'
        report = migration.apply(self.root, backup)
        self.assertTrue(report['privateCredentialsPreserved'])
        document = json.loads(self.account.read_bytes())
        self.assertEqual(document['config']['userIdMappings'], {self.principal: '10001'})
        self.assertEqual(document['appSecret'], 'FAKE_SECRET')
        merged = json.loads(self.old.read_bytes())
        self.assertEqual([r['id'] for r in merged], ['11', '10', '9'])
        self.assertEqual(merged[1]['name'], 'old-10')
        self.assertEqual(self.new.read_bytes(), source_bytes)
        tokens = json.loads(self.old_token.read_bytes())
        self.assertEqual(tokens['109000001']['stoken'], 'FAKE_NEW_TOKEN')
        self.assertEqual(tokens['109000001']['userId'], '10001')
        self.assertFalse(tokens['109000001']['is_sign'])
        self.assertEqual(tokens['109000002']['stoken'], 'FAKE_EXTRA_TOKEN')
        self.assertEqual(self.new_token.read_bytes(), new_token_bytes)
        self.assertNotIn(b'FAKE_SECRET', (backup / 'journal.json').read_bytes())
        migration.rollback(self.root, backup)
        self.assertEqual(self.old.read_bytes(), old_bytes)
        self.assertEqual(self.old_token.read_bytes(), token_bytes)
        self.assertEqual(self.new.read_bytes(), source_bytes)
        self.assertNotIn('userIdMappings', json.loads(self.account.read_bytes())['config'])

    def test_ambiguous_old_accounts_are_not_guessed(self):
        self.user('10002', '555', '109000001')
        plan = migration.audit(self.root)
        self.assertEqual(plan['mappings'], {})
        self.assertEqual(plan['report']['ambiguous'], 1)
        self.assertEqual(plan['changes'], [])

    def test_different_games_do_not_associate_even_with_same_binding(self):
        self.db.execute('update Users set games=? where id=?', (json.dumps({'gs': {'uid': '109000002'}}), self.principal)); self.db.commit()
        self.assertEqual(migration.audit(self.root)['mappings'], {})

    def test_other_platform_numeric_accounts_are_not_legacy_qq_candidates(self):
        self.db.execute('insert into Users values(?,?,?,?)', ('10002', 'telegram', '555', json.dumps({'gs': {'uid': '109000001'}}))); self.db.commit()
        self.assertEqual(migration.audit(self.root)['mappings'], {self.principal: '10001'})

    def test_invalid_record_owner_stops_before_any_write(self):
        before = self.account.read_bytes(), self.old.read_bytes()
        self.new.write_text(json.dumps([{'uid': '109999999', 'id': '11'}]))
        with self.assertRaises(ValueError):
            migration.apply(self.root, self.base / 'rollback')
        self.assertEqual(before, (self.account.read_bytes(), self.old.read_bytes()))

    def test_unverified_credential_accounts_never_merge(self):
        self.new_token.write_text(json.dumps({'109000001': {'uid': '109000001', 'stuid': '666', 'userId': self.principal}}))
        before = self.account.read_bytes(), self.old.read_bytes(), self.old_token.read_bytes()
        with self.assertRaises(ValueError):
            migration.apply(self.root, self.base / 'rollback')
        self.assertEqual(before, (self.account.read_bytes(), self.old.read_bytes(), self.old_token.read_bytes()))

    def test_newer_legacy_credentials_are_never_replaced_by_an_older_namespace_copy(self):
        os.utime(self.old_token, ns=(3000000000, 3000000000))
        original = self.old_token.read_bytes()
        report = migration.apply(self.root, self.base / 'rollback')
        self.assertEqual(report['credentialFilesUpdated'], 0)
        self.assertEqual(self.old_token.read_bytes(), original)

    def test_group_and_private_aliases_merge_once_using_the_newest_credentials(self):
        private = 'qqbot:123456:c2c-user:verified-private'
        self.user(private, '555', '109000001')
        self.file(private, [{'uid': '109000001', 'id': '12'}])
        token = self.new_token.with_name(private + '.yaml')
        token.write_text(json.dumps({'109000001': {'uid': '109000001', 'stuid': '555', 'userId': private, 'stoken': 'FAKE_NEWEST_TOKEN'}}))
        os.utime(token, ns=(3000000000, 3000000000))
        report = migration.apply(self.root, self.base / 'rollback')
        self.assertEqual(report['mappingsAdded'], 2); self.assertEqual(report['credentialFilesUpdated'], 1)
        self.assertEqual([item['id'] for item in json.loads(self.old.read_bytes())], ['12', '11', '10', '9'])
        self.assertEqual(json.loads(self.old_token.read_bytes())['109000001']['stoken'], 'FAKE_NEWEST_TOKEN')

    def test_idempotent_apply_and_safe_rollback_refuses_newer_updates(self):
        first = self.base / 'first'; migration.apply(self.root, first)
        second = migration.apply(self.root, self.base / 'second')
        self.assertEqual(second['newRecordsAdded'], 0); self.assertEqual(second['mappingsAdded'], 0)
        self.old.write_text(json.dumps([{'uid': '109000001', 'id': '12'}]))
        with self.assertRaises(ValueError):
            migration.rollback(self.root, first)
        self.assertEqual(json.loads(self.old.read_text())[0]['id'], '12')

    def test_symlink_or_conflicting_explicit_mapping_is_rejected(self):
        self.new.unlink(); self.new.symlink_to(self.old)
        with self.assertRaises(ValueError):
            migration.audit(self.root)
        self.new.unlink(); self.file(self.principal, [])
        document = json.loads(self.account.read_bytes()); document['config']['userIdMappings'] = {self.principal: '10002'}; self.account.write_text(json.dumps(document))
        with self.assertRaises(ValueError):
            migration.audit(self.root)


if __name__ == '__main__':
    unittest.main()
