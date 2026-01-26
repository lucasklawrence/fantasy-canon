export function computeLuckIndex(input) {
    const { wins, expectedWins } = input;
    return wins - expectedWins;
}
