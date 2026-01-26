import { createHash } from "node:crypto";
export function deterministicIndex(seed, drawIndex, bagSize) {
    if (bagSize <= 0) {
        throw new Error("bagSize must be greater than zero");
    }
    if (drawIndex < 0) {
        throw new Error("drawIndex cannot be negative");
    }
    const hashInput = `${seed}:${drawIndex}`;
    const digest = createHash("sha256").update(hashInput).digest();
    const value = digest.readUInt32BE(0);
    return value % bagSize;
}
