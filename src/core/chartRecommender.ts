import type {ChartRecommendation, DatasetProfile} from '../types';

export function recommendCharts(profile: DatasetProfile): ChartRecommendation[] {
  const recs: ChartRecommendation[] = [];
  const cols = profile.columns;
  if (cols.length === 0 || profile.rowCount === 0) return recs;

  const quantCols = profile.quantCols;
  const catCols = profile.catCols;
  const temporalCols = profile.temporalCols;
  const boolCols = profile.boolCols;

  const lowCardCats = catCols.filter((c) => {
    const p = cols[c];
    return p && p.cardinality >= 2 && p.cardinality <= 16;
  });
  const highCardCats = catCols.filter((c) => {
    const p = cols[c];
    return p && p.cardinality > 24;
  });

  // 1. Temporal + Quantitative -> Time-series trend
  if (temporalCols.length >= 1 && quantCols.length >= 1) {
    const tCol = temporalCols[0];
    const yCol = quantCols[0];
    const groupCol = lowCardCats[0] ?? boolCols[0] ?? null;
    recs.push({
      id: `trend-${tCol}-${yCol}`,
      title: `Trend: ${cols[yCol].name} over ${cols[tCol].name}`,
      reason: `Detected temporal "${cols[tCol].name}" paired with numeric "${cols[yCol].name}".`,
      targetSurface: '2d',
      chartType: 'line',
      suggested2D: {
        type: 'line',
        xColIndex: tCol,
        yColIndices: quantCols.slice(0, 2),
      },
      suggestedSpatial: {
        xColIndex: tCol,
        yColIndex: yCol,
        groupByColIndex: groupCol,
        aggregation: profile.rowCount > 24 ? 'avg' : 'none',
      },
    });
  }

  // 2. 3+ Quantitative (or Temporal + 2+ Quant) -> True 3D Scatter relationship
  const quantOrTemp = [...quantCols, ...temporalCols];
  if (quantOrTemp.length >= 3) {
    const xCol = quantOrTemp[0];
    const yCol = quantOrTemp[1];
    const zCol = quantOrTemp[2];
    const colorCol = lowCardCats[0] ?? boolCols[0] ?? quantOrTemp[3] ?? null;
    recs.push({
      id: `scatter3d-${xCol}-${yCol}-${zCol}`,
      title: `3D Scatter: ${cols[xCol].name} × ${cols[yCol].name} × ${cols[zCol].name}`,
      reason: `${quantOrTemp.length} quantitative/temporal columns allow exploring 3D relationships${colorCol !== null ? ` colored by "${cols[colorCol].name}"` : ''}.`,
      targetSurface: '3d',
      spatialMode: 'scatter3d',
      suggestedSpatial: {
        xColIndex: xCol,
        yColIndex: yCol,
        zColIndex: zCol,
        colorColIndex: colorCol,
        aggregation: 'none',
      },
    });
  }

  // 3. Categorical comparison -> Grouped 3D Bars (when secondary category exists) or Aggregated 3D Bars
  if (lowCardCats.length >= 1 && quantCols.length >= 1) {
    const xCol = lowCardCats[0];
    const yCol = quantCols[0];
    const groupCol =
      lowCardCats.find((c) => c !== xCol && cols[c].cardinality <= 8) ??
      boolCols.find((c) => c !== xCol) ??
      null;
    const hasRepeated = profile.rowCount > Math.max(1, cols[xCol].cardinality);

    recs.push({
      id: `bar3d-${xCol}-${yCol}`,
      title:
        groupCol !== null
          ? `Grouped 3D Bars: ${cols[yCol].name} by ${cols[xCol].name} × ${cols[groupCol].name}`
          : `Compare ${cols[yCol].name} across ${cols[xCol].name}`,
      reason:
        groupCol !== null
          ? `"${cols[xCol].name}" (${cols[xCol].cardinality}) and "${cols[groupCol].name}" (${cols[groupCol].cardinality}) cleanly slice "${cols[yCol].name}" in 3D.`
          : `${hasRepeated ? `Multiple rows per "${cols[xCol].name}" benefit from AVG aggregation.` : `"${cols[xCol].name}" has ${cols[xCol].cardinality} distinct groups.`}`,
      targetSurface: '3d',
      spatialMode: 'bar3d',
      suggestedSpatial: {
        xColIndex: xCol,
        yColIndex: yCol,
        groupByColIndex: groupCol,
        aggregation: hasRepeated || profile.rowCount > 24 ? 'avg' : 'none',
        sortOrder: 'value-desc',
      },
    });
  } else if (highCardCats.length >= 1 && quantCols.length >= 1) {
    const xCol = highCardCats[0];
    const yCol = quantCols[0];
    recs.push({
      id: `topk-bar3d-${xCol}-${yCol}`,
      title: `Top-K Summary: ${cols[yCol].name} by ${cols[xCol].name}`,
      reason: `"${cols[xCol].name}" has high cardinality (${cols[xCol].cardinality}+); Top-16 aggregation prevents label clutter.`,
      targetSurface: '3d',
      spatialMode: 'bar3d',
      suggestedSpatial: {
        xColIndex: xCol,
        yColIndex: yCol,
        groupByColIndex: null,
        aggregation: 'sum',
        sortOrder: 'value-desc',
        topK: 16,
      },
    });
  }

  // 4. 2+ Quantitative -> 2D Scatter correlation
  if (quantCols.length >= 2) {
    const xCol = quantCols[0];
    const yCol = quantCols[1];
    recs.push({
      id: `scatter2d-${xCol}-${yCol}`,
      title: `2D Correlation: ${cols[xCol].name} vs ${cols[yCol].name}`,
      reason: `Explore linear or cluster correlation between two numeric metrics.`,
      targetSurface: '2d',
      chartType: 'scatter',
      suggested2D: {
        type: 'scatter',
        xColIndex: xCol,
        yColIndices: [yCol],
      },
    });
  }

  // 5. Suitable Proportional 3D Ring (strictly non-negative, low-cardinality categories)
  const ringCat = lowCardCats.find((c) => cols[c].cardinality <= 8) ?? boolCols[0];
  const nonNegQuant = quantCols.find((c) => !cols[c].hasNegative && cols[c].hasPositive);
  if (ringCat !== undefined && nonNegQuant !== undefined) {
    recs.push({
      id: `ring3d-${ringCat}-${nonNegQuant}`,
      title: `Share Breakdown: ${cols[nonNegQuant].name} by ${cols[ringCat].name}`,
      reason: `Non-negative "${cols[nonNegQuant].name}" across ${cols[ringCat].cardinality} groups fits a proportional 3D Ring.`,
      targetSurface: '3d',
      spatialMode: 'ring3d',
      suggestedSpatial: {
        xColIndex: ringCat,
        yColIndex: nonNegQuant,
        aggregation: 'sum',
        sortOrder: 'value-desc',
      },
    });
  }

  // 6. Fallback when dataset only has categorical/text columns -> Count by Category
  if (recs.length === 0 && (catCols.length > 0 || boolCols.length > 0)) {
    const xCol = catCols[0] ?? boolCols[0];
    recs.push({
      id: `count-${xCol}`,
      title: `Frequency Count by ${cols[xCol].name}`,
      reason: `No quantitative metrics detected; counting records per "${cols[xCol].name}" reveals distribution.`,
      targetSurface: '3d',
      spatialMode: 'bar3d',
      suggestedSpatial: {
        xColIndex: xCol,
        yColIndex: xCol,
        aggregation: 'count',
        sortOrder: 'value-desc',
      },
    });
  }

  return recs.slice(0, 4);
}
