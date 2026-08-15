# The 2025 draft, reviewed after the season

How the model's 2025 draft board differed from consensus (ranking by
2024 points per game), and how each call aged. The board came from
`scripts/review2025.ts` using only information available at draft
time: 2015 through 2024 stats and the 2025 week-1 rosters. No 2025
outcome touched any model decision; 2025 entered the repo after the
model was finished, and on it the ridge and tree mix had its best
season on both evaluations (0.825 pooled rank correlation, 0.583 on
the top 30 against 0.251 for consensus).

One caveat up front: the coordinator dataset ends at 2024, so the
model treated every 2025 coordinator as new. Those features carry
near-zero weight, so projections barely moved, but no 2025 call below
can be credited to coordinator information.

## The fades that paid

The model's clearest wins came from fading age and thin durability at
the top of the consensus board.

- **Chris Godwin** (consensus 12, model 59): 29 years old, seven games
  played in 2024, and Tampa Bay had drafted receiver help. He managed
  9.2 points per game over nine games. This was the model's largest
  single disagreement with consensus, and its best.
- **Alvin Kamara** (14, model 37): age 30. Fell from 18.9 to 9.2.
- **Joe Mixon** (31, model 68): age 29 with rookie competition behind
  him. Never played a snap in 2025.
- **Mike Evans** (32, model 76): age 33. 10.6 per game over eight.
- **James Conner** (43, model 58): age 30. Three games.
- **Tee Higgins** (19, model 36): twelve games the year before. Fell
  to 14.1.
- **Brian Thomas** (35, model 48) and **Chuba Hubbard** (41, model
  50): both faded, both collapsed to under 10.

Several of these players lost their seasons to injury, which the model
does not predict. What it does price is that a 30-year-old back with a
short prior season misses time more often than his points suggest, and
in 2025 that base rate showed up.

- **Justin Jefferson** (16, model 21): the model marked him down for a
  quarterback change and drafted competition and was directionally
  right but not bearish enough. 11.8 per game was a top-30 disaster
  that even rank 21 flattered.

## The promotions that paid

- **Puka Nacua** (consensus 15, model 6): young, and his 2024 was
  suppressed by missed games rather than performance. 23.4 per game,
  the best receiver season in football.
- **Bo Nix** (17, model 7): second-year quarterback. 19.2.
- **Justin Herbert** (34, model 13): the model's biggest promotion
  into the top 15. 19.6.
- **Brock Purdy** (22, model 12): 21.9 per game across the nine games
  he played.

## The misses

- **Jonathan Taylor** (consensus 25, model 43) is the worst call on
  the board. The model faded a volume back in his prime for no strong
  reason, and he delivered a career year at 21.3.
- **Derrick Henry** (11, model 35) and **Davante Adams** (29, model
  61): the age fade fired on both, and both held their value. The age
  curve is a base rate, and these two keep beating it.
- **Jayden Daniels** (8, model 1) and **Malik Nabers** (20, model 4):
  the model's two boldest promotions both lost their seasons to
  injury, Daniels at seven games and Nabers at four. Neither looked
  like the projection while playing. Promoting young ascending players
  was right on average this year, and these two show the variance
  around that average.
- **Sam Darnold** (21, model 72): the model saw a career-outlier
  season, a team change, and touchdown dependence, and priced a
  collapse. He fell only to 15.5. Directionally right, magnitude
  overdone; rank 72 was much too cruel.

## What the year says about the model

The age and durability fades were the story of 2025: seven of the ten
biggest fades among the consensus top 45 beat the consensus rank, and
several captured season-ending injuries that no one predicts directly,
because injury risk and the model's fade signals travel together. The
promotions of young players with suppressed prior seasons hit at a
high rate, with the two loudest exceptions being injuries. The
recurring miss is the durable outlier: veterans like Henry and Adams,
and volume backs like Taylor, whom the base rates fade every year and
who keep not fading. A player-specific durability signal, rather than
age and games alone, is the missing information, and it is the same
lesson the top-of-board experiment taught: the model's edge over
consensus comes from base rates the crowd underweights, and its misses
come from individuals who have repeatedly beaten those base rates.
