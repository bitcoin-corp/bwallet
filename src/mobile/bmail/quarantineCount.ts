/**
 * bMail › Quarantine holds two lists: quarantined letters and airdropped tokens/NFTs. The tab badge counts both, so
 * "Quarantine is empty" must only show when both are empty (24 Oct 2026: badge 2, two NFTs listed, and the empty
 * note above them because it only looked at letters).
 */
export const quarantineTotal = (letters: number, drops: number) => letters + drops;
export const quarantineIsEmpty = (letters: number, drops: number) => quarantineTotal(letters, drops) === 0;
