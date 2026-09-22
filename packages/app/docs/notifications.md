# Notifications

The app can tell you by email or Telegram when something happens to a name of yours, so you do not have to open it to find out. It is optional, and it is per address: sign in once with an address and every name it holds, sells, bids on or receives messages for is covered.

## Signing in

Open the address panel in the top corner and tap **Notifications**. The wallet signs a short text naming your address and this site. Nothing is sent on chain and nothing is paid. The signature is how the service knows the address is yours, so only you can see and change these settings.

If your wallet holds several addresses, it chooses which one signs. When it signs with another address than the one you picked, the sheet says so and names it. Pick that address in the panel and sign in again.

## Where you are reached

**Email.** Type an address and open the confirmation link that arrives. Nothing is sent until you do. Every message carries a one-click link that stops them.

**Telegram.** Tap **Connect Telegram**. It opens the service's bot with a code that ties that chat to your address. Press **Start** and you are linked. No username is typed or stored. Send `/stop` to the bot to unlink the chat.

The bot also answers questions. Send it a name and it replies with the address the name pays to, the owner and the expiry. `/names` lists the names of your linked addresses.

## What is sent

Each group is a switch in the sheet, on by default.

| Group | When |
|---|---|
| Renewal reminders | {{dur:RENEW_WINDOW}} before a name expires, when it stops resolving, and a last call before anyone can register it |
| Sales and bids | A name of yours was bought, someone bid on your auction, you were outbid, or an auction you were in closed |
| Transfers to me | Someone started a transfer of a name to your address, and when it completes |
| New messages | Someone sent your address a message. The sender is named, the text is not |

Your own registrations, renewals, offers, cancellations and bids are not reported. You were there.

## What is stored, and how to delete it

The service keeps your address, the contacts you added, your switches and a record of which messages it already sent, so a restart never sends one twice. It holds no key and cannot move a name or any funds.

Every email has an unsubscribe link and the bot understands `/stop`. **Delete everything about this address** in the sheet removes all of it at once. A contact that keeps failing, a dead mailbox or a chat that blocked the bot, is dropped on its own.

The service reads the public registry and the public message index, the same data the app shows. An operator hosting their own copy of the app can run one or leave it out. Without one, the app shows no Notifications row.
