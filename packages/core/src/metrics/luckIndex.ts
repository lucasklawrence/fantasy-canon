export interface LuckIndexInput {
  wins: number;
  expectedWins: number;
}

export function computeLuckIndex(input: LuckIndexInput): number {
  const { wins, expectedWins } = input;
  return wins - expectedWins;
}
