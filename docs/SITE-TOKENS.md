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

### 4. See one token's coins (sell coins you did not deliver)

Coins the user bought in bWalletX's own Exchange, in another browser, or before site tokens are not ones you
built, so you do not know their outpoints. Ask for exactly one token:

```ts
const r = await wallet.listOutputs({ basket: 'bsv21', tags: [`bsv21:${tokenId}`] });
// r = {
//   totalOutputs: 2,
//   outputs: [
//     { outpoint: '<txid>.<vout>', satoshis: 1, spendable: true, amount: '1000000' }, // amount: raw units, string
//     ...
//   ],
// }
```

- The first time a site asks for a token, bWalletX shows one sheet: `<site> wants to see your $SYM balance`. Yes is
  remembered for that site and that token; another token, or another site, asks again. No throws
  `You said no: this site cannot see that balance`.
- The answer is only those four fields, for coins of that token id. No locking scripts, no BEEF, no
  `customInstructions`, no keys, no tags, no other tokens. `include`, `includeCustomInstructions`, `includeTags`
  are ignored. `limit` (default 100, max 1000) and `offset` work.
- `tags` must be exactly one `bsv21:<txid>_<vout>`. Any other listing of `bsv21` (no tag, two tags,
  `bsv21:deploy`…) is still refused, and `relinquishOutput` stays refused.
- Sell them with step 3: name the outpoints as inputs. The wallet signs with the keys on its own records, so coins
  from the Exchange or another device sell the same way as coins you delivered.

### What the wallet gives back (for verifying a sell on your server)

- `createAction(...).signableTransaction.tx` is an AtomicBEEF (`number[]`) of the unsigned tx. It holds the raw
  source transaction of **every** input, including the wallet's own token inputs (no merkle proofs at this stage).
- `signAction(...)` returns `{ txid, tx }`. `tx` is an AtomicBEEF (`number[]`) of the signed tx together with the
  input BEEF (source transactions, with proofs where the wallet has them). Read it with
  `Transaction.fromAtomicBEEF(tx)`; `tx` is left out only if you pass `options.returnTXIDOnly: true`. With
  `signAndProcess` left on, `createAction` returns the same `{ txid, tx }`.

### 5. Deploy a token and inscribe its icon

The owner-only deploy (BSV-21 deploy+mint to a wallet key) and the icon inscription no longer need `[0,'onesat']`.

```ts
// a) receive keys, picked by the wallet
const dep = await wallet.getPublicKey({ protocolID: [1, 'bwalletx token receive'], keyID: 'deploy', counterparty: 'self' });
// dep = { publicKey, keyID: 'deploy-<ms>' }
const ico = await wallet.getPublicKey({ protocolID: [1, 'bwalletx ordinal receive'], keyID: 'ordinal', counterparty: 'self' });
// ico = { publicKey, keyID: 'ordinal-<ms>' }

// b) the icon: an image inscription to the ordinal key, into '1sat' (createAction or internalizeAction)
{
  lockingScript: inscription(contentType, bytes, icoAddress), // see below
  satoshis: 1,
  basket: '1sat',
  customInstructions: JSON.stringify({ keyID: ico.keyID }),
}

// c) the deploy: build it as a plain output (no basket) in your createAction, sign it, then take it in:
const { txid, tx } = await wallet.createAction({
  description: 'Deploy $SYM',
  outputs: [{ lockingScript: deployMint.toHex(), satoshis: 1, outputDescription: 'Deploy $SYM' }],
});
await wallet.internalizeAction({
  tx,
  description: 'Your new $SYM',
  outputs: [
    {
      outputIndex: 0,
      protocol: 'basket insertion',
      insertionRemittance: { basket: 'bsv21', customInstructions: JSON.stringify({ keyID: dep.keyID }) },
    },
  ],
});
// the token id is `${txid}_0`
```

The scripts, each followed by P2PKH to the key's address and nothing else:

```
icon:   OP_0 OP_IF "ord" OP_1 "<image/png|jpeg|gif|webp|svg+xml|avif>" OP_0 <bytes> OP_ENDIF
deploy: OP_0 OP_IF "ord" OP_1 "application/bsv-20" OP_0 '{"p":"bsv-20","op":"deploy+mint","sym":"SYM","amt":"1000000000","dec":"0","icon":"_1"}' OP_ENDIF
```

- Deploy JSON: only `p`, `op`, `sym`, `amt`, optional `dec` (0–18), optional `icon` (`_<vout>` or
  `<txid>_<vout>`), all strings, any order. `amt` has no leading zeros. The wallet rebuilds the script from what it
  read and refuses it unless every byte matches. Icon body: 1 byte to 1 MB.
- A deploy goes in only with `internalizeAction`: its token id is its own outpoint, which exists once the tx is
  signed. A deploy into `bsv21` inside `createAction` is refused: `A token deploy goes into your wallet with
internalizeAction once it is signed`.
- The wallet writes the records: the deploy gets `{ id, amt, op: 'deploy+mint', sym, dec, icon, protocolID, keyID }`
  with tags `bsv21:deploy` and `bsv21:<id>`; the icon gets `{ protocolID, keyID }` with tag `type:<contentType>`.
  Whatever you sent there is thrown away.
- A deploy key takes only a deploy, an ordinal key only an image inscription, a transfer key only its token's
  transfer. `bwalletx ordinal receive` is `getPublicKey` only, like `bwalletx token receive`.

## What a site still cannot do

| Attempt                                                                                                             | Answer                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `getPublicKey` / `createSignature` / any crypto call with `[0,'onesat']`                                            | `This protocol is reserved for bWalletX itself: "onesat"`                         |
| `createSignature` (or encrypt, HMAC, linkage) with `[1,'bwalletx token receive']`                                   | `bwalletx token receive is for getPublicKey only`                                 |
| `listOutputs` on `bsv21` without exactly one `bsv21:<tokenId>` tag; `relinquishOutput` on `bsv21`                   | `This basket is reserved for bWalletX itself: "bsv21"`                            |
| Output into `bsv21` to an address the wallet did not give this site, a different token id, 2+ sats, or extra script | `bWalletX takes a token into your wallet only to a receive key it gave this site` |
| Fake symbol, icon, amount or key in `customInstructions`                                                            | Ignored: the wallet writes the record from the script and its own key             |
| Outputs into `1sat`, `lock`, `opns`, `default`…                                                                     | Refused as before (`reservedBaskets.ts`)                                          |
| Signing the wallet's token inputs itself                                                                            | Refused; the wallet signs them after the sheet                                    |

## Other BRC-100 wallets

Step 1 is an ordinary `getPublicKey`. A wallet that does not know this protocol returns a key derived under
`[1,'bwalletx token receive']` with your `keyID` (the token id) and no `keyID` in the answer. Then write the record
yourself in step 2 (`customInstructions: { protocolID: [1,'bwalletx token receive'], keyID: tokenId, ... }`) the way
that wallet expects. When the answer carries `keyID`, you are talking to bWalletX and the steps above apply.
