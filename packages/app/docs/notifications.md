# Notifications

The app can tell you by email or Telegram when something happens to a name of yours, so you do not have to open it to find out. It is optional, and it is per address: sign in once with an address and every name it holds, sells, bids on or receives messages for is covered.

## Signing in

Tap the **bell** in the top corner, beside the sun and moon button. It is there once a wallet is connected, on every screen but the landing page, and it opens the sheet for the address in the corner: switch address there to set up another's.

**Sign in with this address** asks the wallet to sign a short text naming your address and this site. Nothing goes on chain and nothing is paid. The signature proves the address is yours, so only you can see and change these settings. **Sign out** ends the session on this device and keeps everything you set.

If your wallet holds several addresses, it chooses which one signs. When it signs with another address than the one you picked, the sheet says so and names it. Pick that address in the corner and sign in again.

## Where you are reached

The sheet lists the channels the service has set up, under **Where to reach you**.

**Email.** Type an address, tap **Add**, and open the confirmation link that arrives. Until you do, the row reads **Waiting for confirmation** and nothing is sent to it. Every message carries a one-click link that stops them.

**Telegram.** Tap **Connect Telegram**, then **Open Telegram**. It opens the service's bot with a code that ties that chat to your address. Press **Start** and the row reads **Linked**. No username is typed or stored. **Remove** in the sheet, or `/stop` sent to the bot, unlinks the chat.

The bot also answers questions. Send it a name and it replies with the address the name pays to, the owner when that is a different address, the expiry, and a link to pay it. A name nobody holds comes back with a link to register it. `/names` lists the names of every address linked to that chat, and `/help` the commands.

## What is sent

Each group is a switch under **Send me**, on by default.

| Group | When |
|---|---|
| Renewal reminders | When renewal opens, {{dur:RENEW_WINDOW}} before the name expires. When it stops resolving. A last call in the final days of grace, before anyone can register it |
| Sales and bids | A name of yours was bought, someone bid on your auction, you were outbid, or an auction you were in closed |
| Transfers to me | Someone started a transfer of a name to your address, and when it completes |
| New messages | Someone sent your address a message. The sender is named, the text is not |

Your own registrations, renewals, offers, cancellations and bids are not reported. You were there. Nothing that happened before you signed in is reported either, with one exception: a name already inside its renewal window gets its latest reminder, so signing in with five days of grace left brings the last call, not three messages. A lifetime name is a century from its reminder.

## What is stored, and how to delete it

The service keeps your address, the contacts you added, your switches and a record of which messages it already sent, so a restart never sends one twice. It holds no key and cannot move a name or any funds. A contact is never shown back whole: the sheet masks an email and shows no chat.

Every email has an unsubscribe link and the bot understands `/stop`. **Delete everything about this address** in the sheet removes all of it at once. A contact that keeps failing, a dead mailbox or a chat that blocked the bot, is dropped on its own.

The service reads the public registry and the public message index, the same data the app shows. An operator hosting their own copy of the app can run one or leave it out ([Running your own](operators)). Without one, the app shows no bell.
