# Pay

Type a name, an amount, and the wallet signs. Nothing is written to the registry. This is an ordinary payment to the address the name resolved to.

## NIM or USDT

- **NIM** goes to the address the name points to.
- **USDT on Polygon** goes to the EVM address the name's owner linked. A name with no linked address says so.

A USDT payment goes through the wallet's EVM provider as a plain token transfer, and Polygon charges its fee in POL. With no POL the wallet refuses, and the app says "The wallet has no POL for Polygon's network fee. Nothing was sent." Once the wallet accepts the transfer, the app hands you a Polygonscan link.

## What you see before you pay

Under the address is the **verification line**, the same one the Buy card carries ([The verification line](verification)). Beside the address is the **identicon** of what will be paid, and the wallet shows it again in its own sheet.

The app refuses a payment to your own address and an amount of zero, because the network would drop both without an error.

## The pin check

The first time you use a name on a device, the app remembers where it pointed. If it later points somewhere else, Pay stops: "Stop. This name changed address", both addresses with both identicons, and the button disabled. The owner may have repointed the name, or someone may be redirecting payments. Do not pay until you know which. Overriding takes two taps and replaces what the device remembers.

## The message

A NIM payment can carry a short **message**, like an invoice or an order number. It travels in the transaction's data field, so it is public and permanent. The field counts what is left of its 64 bytes as you type. An accent or an emoji costs more than one byte.

Two messages are refused before the button lights: one over 64 bytes, and one beginning `NNS1`, which is how a name message starts. A USDT payment carries no message, because a token transfer has nowhere to put one.

## Payment links

A link opens Pay with the fields already filled:

```
https://nimiqnames.com/pay/donald?amount=25&message=INV-42
```

`donald` is the recipient, `amount` and `message` fill the two fields, and `asset=usdt` asks for USDT instead of NIM. Pasted into a chat, the link previews as a card saying who is being paid and how much. Every field stays editable, and nothing is sent until you press Pay. The message that came with the link is read-only until you tap **Edit**.

Tapping a link in a chat app opens your browser, not Nimiq Pay. Inside the mini app, paste the link where the name goes and the fields fill in.

Owners build one from the **Request Payment** tile in [My Names](my-names).
