/**
 * Turns a point predictor into a distribution by remembering how wrong
 * it was on training data. Residuals get bucketed by prediction level
 * within each position, because a 20-point projection misses by more
 * than a 5-point one and the miss is skewed toward the upside. Sampling
 * an outcome is then prediction plus a residual drawn from the matching
 * bucket, which is exactly what a season simulator needs.
 */

export interface ResidualModel {
  /** per position: ascending bucket upper bounds and each bucket's sorted residuals */
  positions: Map<string, { bounds: number[]; residuals: number[][] }>;
}

export interface TrainingPoint {
  position: string;
  predicted: number;
  actual: number;
}

export function buildResidualModel(
  points: TrainingPoint[],
  buckets: number,
): ResidualModel {
  const byPosition = new Map<string, TrainingPoint[]>();

  for (const point of points) {
    const list = byPosition.get(point.position) ?? [];
    list.push(point);
    byPosition.set(point.position, list);
  }

  const positions = new Map<string, { bounds: number[]; residuals: number[][] }>();

  for (const [position, list] of byPosition) {
    list.sort((a, b) => a.predicted - b.predicted);

    const bounds: number[] = [];
    const residuals: number[][] = [];
    const size = Math.ceil(list.length / buckets);

    for (let start = 0; start < list.length; start += size) {
      const bucket = list.slice(start, start + size);
      bounds.push(bucket[bucket.length - 1]!.predicted);
      residuals.push(
        bucket.map((p) => p.actual - p.predicted).sort((a, b) => a - b),
      );
    }

    // the top bucket catches every prediction above what training saw
    bounds[bounds.length - 1] = Infinity;
    positions.set(position, { bounds, residuals });
  }

  return { positions };
}

function bucketFor(
  model: ResidualModel,
  position: string,
  predicted: number,
): number[] | undefined {
  const entry = model.positions.get(position);

  if (!entry) {
    return undefined;
  }

  for (let i = 0; i < entry.bounds.length; i++) {
    if (predicted <= entry.bounds[i]!) {
      return entry.residuals[i];
    }
  }

  return entry.residuals[entry.residuals.length - 1];
}

/** the p quantile of the outcome distribution for this prediction */
export function outcomeQuantile(
  model: ResidualModel,
  position: string,
  predicted: number,
  p: number,
): number {
  const residuals = bucketFor(model, position, predicted);

  if (!residuals || residuals.length === 0) {
    return predicted;
  }

  const index = Math.min(
    residuals.length - 1,
    Math.max(0, Math.floor(p * residuals.length)),
  );

  return predicted + residuals[index]!;
}

/** one simulated outcome; rng returns uniform [0, 1) draws */
export function sampleOutcome(
  model: ResidualModel,
  position: string,
  predicted: number,
  rng: () => number,
): number {
  return outcomeQuantile(model, position, predicted, rng());
}

export interface SeasonNoise {
  /** per position: sorted per-season mean residuals across players */
  biasByPosition: Map<string, number[]>;
  /** weekly residuals with each player-season's mean removed */
  within: ResidualModel;
}

export interface SeasonTrainingPoint extends TrainingPoint {
  playerId: string;
  season: number;
}

/**
 * Season totals need two noise scales: how wrong the model is about a
 * player all season (drawn once per simulated season) and how much his
 * weeks vary around that (drawn every week). Building them separately
 * keeps simulated season totals from being too certain.
 */
export function buildSeasonNoise(
  points: SeasonTrainingPoint[],
  buckets: number,
): SeasonNoise {
  const byPlayerSeason = new Map<string, SeasonTrainingPoint[]>();

  for (const point of points) {
    const key = `${point.playerId}|${point.season}`;
    const list = byPlayerSeason.get(key) ?? [];
    list.push(point);
    byPlayerSeason.set(key, list);
  }

  const biasByPosition = new Map<string, number[]>();
  const demeaned: TrainingPoint[] = [];

  for (const list of byPlayerSeason.values()) {
    if (list.length < 6) {
      continue;
    }

    const mean =
      list.reduce((s, p) => s + (p.actual - p.predicted), 0) / list.length;
    const position = list[0]!.position;
    const biases = biasByPosition.get(position) ?? [];
    biases.push(mean);
    biasByPosition.set(position, biases);

    for (const p of list) {
      demeaned.push({
        position: p.position,
        predicted: p.predicted,
        actual: p.actual - mean,
      });
    }
  }

  for (const biases of biasByPosition.values()) {
    biases.sort((a, b) => a - b);
  }

  return {
    biasByPosition,
    within: buildResidualModel(demeaned, buckets),
  };
}

/** one per-season bias draw for a player at this position */
export function sampleSeasonBias(
  noise: SeasonNoise,
  position: string,
  rng: () => number,
): number {
  const biases = noise.biasByPosition.get(position);

  if (!biases || biases.length === 0) {
    return 0;
  }

  return biases[Math.min(biases.length - 1, Math.floor(rng() * biases.length))]!;
}
