import { SeasonYear } from "@fantasy-canon/shared";
export interface FaabLeaderboardEntry {
    teamId: number;
    amount: number;
}
export interface FaabLeaderboardInput {
    season: SeasonYear;
    entries: FaabLeaderboardEntry[];
    limit?: number;
}
export declare function buildFaabLeaderboard({ entries, limit }: FaabLeaderboardInput): FaabLeaderboardEntry[];
