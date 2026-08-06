// Confusion-matrix utilities for the Gate-2 evaluation (SPEC §4/§10):
// builder, per-cluster precision/recall, and an aligned ASCII renderer.
// Rows = actual (gold) cluster, columns = predicted cluster.

export interface ConfusionMatrix {
  /** Label order shared by rows and columns. */
  labels: string[];
  /** counts[i][j] = number of examples with actual labels[i], predicted labels[j]. */
  counts: number[][];
}

/**
 * Build a square confusion matrix. The label set is the union of labels seen
 * in `actual` and `predicted` unless an explicit `labels` order is given
 * (labels not in the list still get appended, so nothing is dropped silently).
 */
export function buildConfusionMatrix(
  actual: string[],
  predicted: string[],
  labels?: readonly string[],
): ConfusionMatrix {
  if (actual.length !== predicted.length) {
    throw new Error(
      `buildConfusionMatrix: actual (${actual.length}) and predicted (${predicted.length}) length mismatch`,
    );
  }
  const order: string[] = [];
  const index = new Map<string, number>();
  const addLabel = (label: string): number => {
    let i = index.get(label);
    if (i === undefined) {
      i = order.length;
      order.push(label);
      index.set(label, i);
    }
    return i;
  };
  for (const label of labels ?? []) addLabel(label);

  // Size unknown until all labels seen; count into a sparse map first.
  const sparse = new Map<string, number>();
  for (let k = 0; k < actual.length; k++) {
    const i = addLabel(actual[k]!);
    const j = addLabel(predicted[k]!);
    const key = `${i}:${j}`;
    sparse.set(key, (sparse.get(key) ?? 0) + 1);
  }
  const n = order.length;
  const counts: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const [key, value] of sparse) {
    const [i, j] = key.split(':').map(Number);
    counts[i!]![j!] = value;
  }
  return { labels: order, counts };
}

export interface LabelMetrics {
  label: string;
  support: number; // actual count (row sum)
  predictedCount: number; // column sum
  truePositives: number;
  precision: number; // TP / predictedCount, 0 when never predicted
  recall: number; // TP / support, 0 when no support
}

/** Per-label precision/recall from a confusion matrix (one-vs-rest). */
export function precisionRecall(matrix: ConfusionMatrix): LabelMetrics[] {
  const { labels, counts } = matrix;
  const n = labels.length;
  const colSums = new Array<number>(n).fill(0);
  const rowSums = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      rowSums[i] = rowSums[i]! + counts[i]![j]!;
      colSums[j] = colSums[j]! + counts[i]![j]!;
    }
  }
  return labels.map((label, i) => {
    const tp = counts[i]![i]!;
    const support = rowSums[i]!;
    const predictedCount = colSums[i]!;
    return {
      label,
      support,
      predictedCount,
      truePositives: tp,
      precision: predictedCount === 0 ? 0 : tp / predictedCount,
      recall: support === 0 ? 0 : tp / support,
    };
  });
}

/** Overall accuracy = trace / total (0 for an empty matrix). */
export function accuracy(matrix: ConfusionMatrix): number {
  let total = 0;
  let correct = 0;
  for (let i = 0; i < matrix.labels.length; i++) {
    for (let j = 0; j < matrix.labels.length; j++) {
      total += matrix.counts[i]![j]!;
    }
    correct += matrix.counts[i]![i]!;
  }
  return total === 0 ? 0 : correct / total;
}

/**
 * Render the matrix as an aligned ASCII table. First column is the actual
 * label; the header row lists predicted labels. Column width adapts to the
 * longest label/count so columns stay aligned for any label set.
 */
export function formatConfusionMatrix(matrix: ConfusionMatrix): string {
  const { labels, counts } = matrix;
  const cellWidth = Math.max(
    5,
    ...labels.map((l) => l.length),
    ...counts.flat().map((c) => String(c).length),
  );
  const rowLabelWidth = Math.max('actual \\ predicted'.length, ...labels.map((l) => l.length));
  const pad = (s: string, w: number): string => s.padStart(w);
  const header = `${'actual \\ predicted'.padEnd(rowLabelWidth)} |${labels
    .map((l) => pad(l, cellWidth))
    .join(' ')}`;
  const divider = `${'-'.repeat(rowLabelWidth)}-+${labels.map(() => '-'.repeat(cellWidth)).join('-')}`;
  const rows = labels.map((label, i) => {
    const cells = counts[i]!.map((c) => pad(String(c), cellWidth)).join(' ');
    return `${label.padEnd(rowLabelWidth)} |${cells}`;
  });
  return [header, divider, ...rows].join('\n');
}

/** Render a compact per-label precision/recall table. */
export function formatMetrics(metrics: LabelMetrics[]): string {
  const labelWidth = Math.max('cluster'.length, ...metrics.map((m) => m.label.length));
  const header = `${'cluster'.padEnd(labelWidth)} | support | predicted | precision | recall`;
  const divider = `${'-'.repeat(labelWidth)}-|---------|-----------|-----------|--------`;
  const rows = metrics.map(
    (m) =>
      `${m.label.padEnd(labelWidth)} | ${String(m.support).padStart(7)} | ${String(
        m.predictedCount,
      ).padStart(9)} | ${m.precision.toFixed(4).padStart(9)} | ${m.recall.toFixed(4).padStart(6)}`,
  );
  return [header, divider, ...rows].join('\n');
}
