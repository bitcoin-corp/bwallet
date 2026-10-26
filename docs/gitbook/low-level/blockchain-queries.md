---
description: BRC-100 wallet methods for querying blockchain state — height, headers, network, version.
icon: cube
---

# Blockchain Queries

**Package:** `@bsv/sdk` (`WalletInterface`)
**Access:** `const { wallet } = useWallet();`

{% hint style="info" %}
Low-level BRC-100 methods. These are read-only and typically do not prompt the user.
{% endhint %}

## getHeight

```ts
wallet.getHeight(input: {}): Promise<{ height: number }>
```

### Example

```tsx
const { height } = await wallet.getHeight({});
console.log('Current block height:', height);
```

---

## getHeaderForHeight

```ts
wallet.getHeaderForHeight(input: { height: number }): Promise<{ header: string }>
```

### Input

```ts
interface GetHeaderForHeightInput {
  height: number; // block height
}
```

### Output

```ts
interface GetHeaderForHeightResult {
  header: string; // hex-encoded 80-byte block header
}
```

### Example

```tsx
const { header } = await wallet.getHeaderForHeight({ height: 890000 });
console.log('Header at 890000:', header);
```

---

## getNetwork

```ts
wallet.getNetwork(input: {}): Promise<{ network: 'main' | 'test' }>
```

### Example

```tsx
const { network } = await wallet.getNetwork({});
if (network !== 'main') console.warn('Not on mainnet');
```

---

## getVersion

```ts
wallet.getVersion(input: {}): Promise<{ version: string }>
```

### Example

```tsx
const { version } = await wallet.getVersion({});
console.log('Wallet version:', version);
```

bWalletX answers in the [BRC-205](https://github.com/bsv-blockchain/BRCs/blob/master/wallet/0205.md) form, with its
pinned-protocol level as an attribute: `bwalletx-5.2.44; pin=3;`. Wallets up to 5.2.44 sent `bwalletx-5.2.40+p2`.
Read the level with either form, and take the larger of it and the `pinnedProtocols` field when the transport carries
one:

```ts
const m = version.match(/(?:\+p|; pin=)(\d+)\b/);
const pinLevel = m ? Number(m[1]) : 0;
```

If the attribute would push the string past 30 bytes (older SDKs still check that limit), the wallet sends only the
base, such as `bwallet-mobile-55.55.555`.

---

## Common pitfalls

{% hint style="info" %}
The wallet caches blockchain data and may serve slightly stale values for `getHeight` (typically within a block of the tip). Do not rely on perfect synchrony.
{% endhint %}

## Related

- [Concept: BRC-100](../concepts/brc-100.md)
- [Concept: Permissions](../concepts/permissions.md)
- [Transaction Actions](./transaction-actions.md)
