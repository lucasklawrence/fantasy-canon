import { deterministicIndex } from "./rng.js";
export function encodeBallId(teamId, ballNumber) {
    return `${teamId}:${ballNumber}`;
}
function totalBallsForTeam(team, baseBallCount) {
    const base = team.baseBalls ?? baseBallCount;
    const bonus = team.bonusBalls ?? 0;
    const total = base + bonus;
    if (total <= 0) {
        throw new Error(`Team ${team.teamId} must have at least one ball`);
    }
    return total;
}
export function buildBallBag(teams, baseBallCount = 1) {
    const seen = new Set();
    const bag = [];
    for (const team of teams) {
        if (seen.has(team.teamId)) {
            throw new Error(`Duplicate teamId detected: ${team.teamId}`);
        }
        seen.add(team.teamId);
        const total = totalBallsForTeam(team, baseBallCount);
        for (let i = 1; i <= total; i += 1) {
            bag.push(encodeBallId(team.teamId, i));
        }
    }
    return bag;
}
export function computeDraftOrder(input) {
    const { seed, teams, baseBallCount = 1 } = input;
    if (teams.length === 0) {
        throw new Error("At least one team is required to run the lottery");
    }
    let bag = buildBallBag(teams, baseBallCount);
    const draws = [];
    const drawnTeams = new Set();
    let drawIndex = 0;
    while (bag.length > 0 && drawnTeams.size < teams.length) {
        const idx = deterministicIndex(seed, drawIndex, bag.length);
        const ballId = bag[idx];
        const [teamId] = ballId.split(":");
        draws.push({
            pick: draws.length + 1,
            drawIndex,
            ballId,
            teamId
        });
        drawnTeams.add(teamId);
        bag = bag.filter((id) => !id.startsWith(`${teamId}:`));
        drawIndex += 1;
    }
    if (drawnTeams.size !== teams.length) {
        throw new Error("Lottery ended before every team received a pick");
    }
    return draws;
}
