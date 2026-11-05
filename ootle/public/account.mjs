// Prints the public key of the router's account in its own wallet, making the account first if there is none.
// The address to fund goes to stderr (the log).   node account.mjs <account name>
import { walletd } from "../pay/tx.mjs";

const name = process.argv[2];
const rpc = walletd();
const a = await rpc("accounts.get", { name_or_address: { Name: name } })
  .catch(() => rpc("accounts.create", { account_name: name, is_default: true, key_index: null }));
const bal = await rpc("accounts.get_balances", { account: { Name: name }, refresh: true }).catch(() => null);
console.error(`[pay] account ${name}: ${a.address ?? a.account.component_address}; balances ${JSON.stringify(bal?.balances?.map((b) => [b.resource_address.slice(0, 20), b.balance]) ?? [])}`);
console.log(a.account.owner_public_key);
