# Inbox

Anyone who finds your name can write to you. A message is a tiny transaction to the name's **owner**, carrying a short text in its data field. Your inbox lists them per sender.

## What a message is

- **Public and permanent.** Anyone can read it on chain, forever. The composer says so before your first send.
- **Plain text.** No links, no formatting. The only action a message can offer is a reply.
- **Short.** {{n:MAX_DATA_BYTES}} bytes at most. The composer counts them.
- **Checkable.** Every message links to its own transaction on a block explorer.

## Who is who

The names above a sender's address come from the registry, not from the message. A sender cannot claim a name they do not hold.

A message to a **subdomain** goes to the address its host answered with, which may not be the parent's owner. The composer says so.

You cannot message your own name, because the network drops a transaction to yourself.

A new message can reach you by email or Telegram as well. The notice names the sender and never carries the text ([Notifications](notifications)).

## Hiding a sender

**Hide sender** silences an address on this device. Hidden conversations collapse into "Hidden (n)", and **Unhide** brings one back.
