# Site tokens: buying and selling BSV-21 tokens from a site

How a site (TokenBlaster BlastPad, a DEX, a launchpad) puts the BSV-21 tokens a user buys into bWalletX's own token
view, and lets the user sell them later. Code: `src/services/siteTokens.ts`. Tests: `src/services/siteTokens.test.ts`.

## Why the old calls fail

Older clients ask for the token key directly:

```ts
wallet.getPublicKey({ protocolID: [0, 'onesat'], keyID, counterparty: 'self' }); // refused
wallet.createSignature({ protocolID: [0, 'onesat'], keyID, hashToDirectlySign }); // refused
// and outputs with basket: 'bsv21' carrying their own customInstructions        // refused unless checked
```

`[0, 'onesat']` holds the user's funds, ordinals, Locks and token keys. Level-0 keys are the same for every site,
the permission manager never asks about level 0, and BRC-42 derivation does not include the calling site. A site
allowed to use it could derive the wallet's real addresses, and with `createSignature` could sign a spend of the
user's coins. So bWalletX answers: `This protocol is reserved for bWalletX itself: "onesat"`. That stays.

## The three calls

### 1. Ask for a receive key (one per buy)

```ts
const { publicKey, keyID } = await wallet.getPublicKey({
  protocolID: [1, 'bwalletx token receive'],
  keyID: tokenId, // the BSV-21 token id, "<txid>_<vout>"
  counterparty: 'self',
});
const address = PublicKey.fromString(publicKey).toAddress();
```

- bWalletX picks a fresh key every time and returns it with the `keyID` it chose (`<tokenId>-<ms>`). Keep that
  `keyID` with the order: send it back in step 2.
- It is the same kind of key the wallet's own trades use, so the coin shows in the token list, Send works, and a
  seed restore finds it.
- No sheet opens. The site learns only the key it was given: it cannot pick the keyID, so it cannot reach any other
  key of the wallet, and two sites never get the same key.
- `keyID` must be a token id and `counterparty` must be `'self'`.
- This protocol answers `getPublicKey` only. `createSignature`, `encrypt`, `decrypt`, `createHmac`,
  `revealSpecificKeyLinkage` with it are refused.

### 2. Deliver: put the token output in the `bsv21` basket

In the buy transaction (the site's `createAction`, or a later `internalizeAction`), the token output must be
exactly:

```ts
{
  lockingScript: bsv21(tokenId, amount, address).toHex(), // see below, byte for byte
  satoshis: 1,
  basket: 'bsv21',
  customInstructions: JSON.stringify({ keyID }),          // the keyID from step 1 (optional, see below)
  outputDescription: 'Your $SYM',
}
```

The script is the standard BSV-21 transfer inscription followed by P2PKH, nothing before or after:

```
OP_0 OP_IF "ord" OP_1 "application/bsv-20" OP_0 '{"p":"bsv-20","op":"transfer","id":"<tokenId>","amt":"<amount>"}' OP_ENDIF
OP_DUP OP_HASH160 <hash160(address)> OP_EQUALVERIFY OP_CHECKSIG
```

(`bsv21()` in `src/mobile/market/launchpad/tokens.ts`, the same as TokenBlaster's `gun.ts`.) The JSON has exactly
those four fields in that order; `amt` is a decimal string without leading zeros.

What the wallet does with it:

- Accepts it only if the address belongs to a receive key it gave **this** site for **this** token id. Otherwise:
  `bWalletX takes a token into your wallet only to a receive key it gave this site`.
- Throws away the site's `customInstructions` and `tags` and writes its own record: id, amount (read from the
  script), the key. Name, symbol, decimals and icon come from the token's own deploy, not from the site.
- No basket permission sheet and no stored grant: this one checked insertion only.
- The rest of the transaction is a normal site payment with its normal payment sheet.

`customInstructions: { keyID }` is how a delivery survives the wallet restarting between steps 1 and 2 (the
wallet then re-derives the key from that keyID and checks it matches the address). Always send it.

Delivering later (graduation, airdrop, a refund):

```ts
await wallet.internalizeAction({
  tx: atomicBeef,
  description: 'Your $SYM',
  outputs: [
    {
      outputIndex: 0,
      protocol: 'basket insertion',
      insertionRemittance: { basket: 'bsv21', customInstructions: JSON.stringify({ keyID }) },
    },
  ],
});
```

Same checks, same record.

### 3. Sell: name the coins, the wallet signs them

The site proposes the transaction and lists the user's token coins as inputs by outpoint. It never signs them.

```ts
const { signableTransaction } = await wallet.createAction({
  description: 'Sell 1,000 $SYM to the TokenBlaster curve for 0.00012 BSV',
  inputBEEF, // your pool coins' BEEF; the wallet has its own coins
  inputs: [
    ...poolInputs, // your inputs, you unlock them
    { outpoint: '<txid>.<vout>', unlockingScriptLength: 108, inputDescription: 'your 1,000 $SYM' },
  ],
  outputs: [
    ...curveOutputs,
    { lockingScript: p2pkh(userAddress), satoshis: payout, outputDescription: 'Your BSV from the sale' },
    // token change back to the user: a fresh receive key from step 1, delivered as in step 2
  ],
  options: { signAndProcess: false, randomizeOutputs: false },
});

// your own inputs only; leave the wallet's token inputs out
await wallet.signAction({ reference: signableTransaction.reference, spends: poolSpends });
```

- When the inputs include wallet token coins, bWalletX opens one sheet first: each token coin that leaves (amount,
  symbol) and every output (what it pays and to whom). No means nothing is created or signed.
- On Allow it signs its own token inputs at `signAction`, with the key on its own record. A `spends` entry for one of
  those inputs is refused: `bWalletX signs its own token inputs; a site may not supply them`.
- The reference belongs to the site that created it; another site's `signAction` on it is refused.
- With `signAndProcess` left on (and no inputs of your own), the wallet signs and sends in one go.
- The site knows the user's coin outpoints because it built them: the buy's token output, and the token change of
  each sell. It can also watch the addresses of the receive keys it was given.

## What a site still cannot do

| Attempt                                                                                                             | Answer                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `getPublicKey` / `createSignature` / any crypto call with `[0,'onesat']`                                            | `This protocol is reserved for bWalletX itself: "onesat"`                         |
| `createSignature` (or encrypt, HMAC, linkage) with `[1,'bwalletx token receive']`                                   | `bwalletx token receive is for getPublicKey only`                                 |
| `listOutputs` / `relinquishOutput` on `bsv21`                                                                       | `This basket is reserved for bWalletX itself: "bsv21"`                            |
| Output into `bsv21` to an address the wallet did not give this site, a different token id, 2+ sats, or extra script | `bWalletX takes a token into your wallet only to a receive key it gave this site` |
| Fake symbol, icon, amount or key in `customInstructions`                                                            | Ignored: the wallet writes the record from the script and its own key             |
| Outputs into `1sat`, `lock`, `opns`, `default`…                                                                     | Refused as before (`reservedBaskets.ts`)                                          |
| Signing the wallet's token inputs itself                                                                            | Refused; the wallet signs them after the sheet                                    |

## Other BRC-100 wallets

Step 1 is an ordinary `getPublicKey`. A wallet that does not know this protocol returns a key derived under
`[1,'bwalletx token receive']` with your `keyID` (the token id) and no `keyID` in the answer. Then write the record
yourself in step 2 (`customInstructions: { protocolID: [1,'bwalletx token receive'], keyID: tokenId, ... }`) the way
that wallet expects. When the answer carries `keyID`, you are talking to bWalletX and the steps above apply.
