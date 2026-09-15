# Inbox

Anyone who finds your name can write to you. A message is a tiny transaction to the name's **owner**, not to the address it pays, carrying a short text in its data field. Your inbox lists them per sender.

## What a message is

- **Public, permanent, and attached to your address.** Anyone can read it on chain, forever. The composer says so before your first send.
- **Plain text.** No links, no formatting, no address detection. A message asking you to pay somewhere is just text, and the only action a message can offer is a reply.
- **Short.** Messages fit in {{n:MAX_DATA_BYTES}} bytes, and the composer counts them.
- **Checkable.** Every message links to its own transaction on a block explorer.

## Who is who

The **names above a sender's address come from the registry**, not from the message. A sender cannot claim a name they do not hold.

A message to a **subdomain** goes to the address the parent's host answered with, the only party the query designates. The composer says that address may not be the parent's owner.

You cannot message your own name. The network would silently drop a transaction to yourself, so the app refuses first.

## Hiding a sender

**Hide sender** silences an address on this device. Hidden conversations collapse into "Hidden (n)" rather than vanishing, and **Unhide** brings one back.
