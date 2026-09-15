# Pay

Type a name and it resolves exactly as in Buy. Then an amount, and the wallet signs. Nothing is written to the registry. This is an ordinary payment whose recipient came from a verified lookup.

## NIM or USDT

- **NIM** goes to the address the name points to.
- **USDT on Polygon** goes to the EVM address the name's owner linked. The switch is on the screen. A name whose owner has not linked one says so and is not payable this way. The send goes through the wallet's EVM provider as a plain token transfer, and **that path pays Polygon's fee in POL**. With no POL the wallet refuses and the app says "The wallet has no POL for Polygon's network fee. Nothing was sent." Once the wallet accepts the transfer, the app hands you a Polygonscan link rather than calling it confirmed.

The wallet's own USDT flow is fee-free because it uses a relay the mini app cannot reach.

## What you see before you pay

Under the address is the **verification line**, the same one the Buy card carries ([The verification line](verification)). Beside the address is the **identicon** of what will be paid, and the wallet shows it again in its own sheet.

Two refusals are made in the app because the network would otherwise fail silently: a payment to your own address (Nimiq drops it), and an amount of zero (Nimiq rejects it).

## The pin check

The first time you use a name on a device, the app remembers where it pointed. If it later points somewhere else, Pay stops: "Stop. This name changed address", both addresses with both identicons, and the button disabled. The owner may have repointed the name, or someone may be redirecting payments. Do not pay until you know which. The override takes two deliberate taps and replaces what the device remembers.

## The message

A NIM payment can carry a short **message**, like an invoice or an order number, so whoever receives it can tell which payment is which. It travels in the transaction's data field, so it is **public and permanent**, readable by anyone against both addresses. The field counts what is left of its 64 bytes as you type. An accent or an emoji costs more than one.

Two messages are refused before the button lights, because both fail silently once sent: one over the budget, and one beginning `NNS1`, which every indexer would read as a name message. A **USDT payment carries no message**, because a token transfer has nowhere to put one, and the screen says so.

## Payment links

A link opens Pay with the fields already filled:

```
https://nimiqnames.com/pay/donald?amount=25&message=INV-42
```

The name is the recipient, `amount` and `message` fill the two fields, and `asset=usdt` asks for USDT instead of NIM. Pasted into a chat, the link draws a card that says who is being paid and how much. Opening it commits nothing: every field stays editable, and the message that came with the link is read-only until you tap **Edit**, so the payee's wording is not lost by accident. Nothing is sent until you press Pay.

**A link you were sent can be pasted into the recipient field.** Tapping a link in a chat app opens your browser, not Nimiq Pay, so a payer already inside the mini app pastes it where a name goes and it applies whole. The field tells a link from a name by the `/pay/` or the `#` in it, neither of which a name can contain.

**Owners build one from their name's card**, under the **Request Payment** tile in My Names ([My Names](my-names)).
