# Correlation inside one game, half-PPR

Each player's own season mean comes off his weekly score first, so these are week-to-week
co-movements, not the fact that good teams have good players. Seasons 2019 through 2025,
1871 games. A game-week counts when both men played half their team's offensive snaps, or,
for kickers and defences, when both scored. Intervals are a bootstrap over games, and
`npx tsx scripts/gameCorrelation.ts` prints the table again.

| pair | n | corr | 95% interval |
| --- | --- | --- | --- |
| QB with own WR1 | 2736 | 0.388 | 0.376 to 0.411 |
| QB with own WR2 | 2297 | 0.387 | 0.362 to 0.418 |
| QB with own TE1 | 2246 | 0.325 | 0.296 to 0.366 |
| QB with own RB1 | 1921 | 0.033 | 0.012 to 0.090 |
| RB1 with own WR1 | 2084 | -0.020 | -0.046 to 0.013 |
| WR1 with own WR2 | 2483 | 0.016 | -0.023 to 0.038 |
| K with own QB | 2954 | 0.085 | 0.055 to 0.111 |
| QB with opposing QB | 1262 | 0.229 | 0.181 to 0.307 |
| QB with opposing WR1 | 2709 | 0.117 | 0.083 to 0.142 |
| QB with opposing RB1 | 1905 | 0.076 | -0.010 to 0.116 |
| RB1 with opposing RB1 | 728 | -0.095 | -0.119 to -0.006 |
| QB with opposing DST | 3047 | -0.406 | -0.425 to -0.384 |
| WR1 with opposing DST | 3282 | -0.166 | -0.194 to -0.124 |
| RB1 with opposing DST | 2306 | -0.256 | -0.282 to -0.216 |

Four groups matter. A quarterback with any of his own pass catchers is 0.33 to 0.39. An
offensive starter against the other side's defence runs from -0.17 to -0.41, which is most
of what a DST week is. The two quarterbacks in a game move together at 0.23, and one picks
up about 0.12 from the other side's WR1. The rest is within a few hundredths of zero: a
back with his own quarterback or his own WR1, two receivers on the same team, a kicker with
his own quarterback, the two backs against each other. A stack is where independent draws
cost the most: the variance of QB plus his own WR1 is 38.8% higher than they say.

Two shared draws per game would cover all four. Give each team a game-script factor,
loaded about 0.6 on the quarterback and about 0.6 on each of WR1, WR2 and TE1, which puts
those pairs near 0.36 and leaves the back off it. Two receivers on the same team must not
inherit it between them, so draw the part of a receiver's week that comes from his cut of
the targets against his teammates, which cancels the shared factor to roughly zero
receiver to receiver. Then one factor per game, loaded about 0.45 on each team's script
factor, gives the two quarterbacks 0.23. Score a defence off the offensive week the other
team drew, and leave the kicker alone.
