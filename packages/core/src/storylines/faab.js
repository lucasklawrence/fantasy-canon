export function buildFaabLeaderboard({ entries, limit = 12 }) {
    const sorted = [...entries].sort((a, b) => b.amount - a.amount);
    return sorted.slice(0, limit);
}
