// Business-free caller fixture. The same class runs in the pinned real loader
// for every account, scope, command spelling and injected delivery outcome.
export function createContractProbe(Plugin, { Bot, name = 'contract-probe', pattern = '^#contract$', onResult = () => {},
  exercise = async ({ event, contact }) => [await event.reply('probe reply'), await contact.sendMsg('probe contact')] } = {}) {
  return class ContractProbe extends Plugin {
    constructor() { super({ name, event: 'message.*', rule: [{ reg: pattern, fnc: 'run', log: false }] }); }
    async run(event) {
      const account = Bot[event.self_id];
      const contact = event.isGroup ? account.pickGroup(event.group_id) : account.pickFriend(event.user_id);
      const observation = { account, contact, eventContact: event.isGroup ? event.group : event.friend,
        userId: event.user_id, senderId: event.sender.user_id, isMaster: event.isMaster };
      const result = await exercise({ event, account, contact, observation });
      await onResult({ event, ...observation, result });
      return true;
    }
  };
}
