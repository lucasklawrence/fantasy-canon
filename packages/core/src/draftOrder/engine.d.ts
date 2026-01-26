import { DraftOrderTeamInput, LotteryDraw, LotteryInput } from "./types.js";
export declare function encodeBallId(teamId: string, ballNumber: number): string;
export declare function buildBallBag(teams: DraftOrderTeamInput[], baseBallCount?: number): string[];
export declare function computeDraftOrder(input: LotteryInput): LotteryDraw[];
