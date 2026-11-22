import type {ExpressionSpecification} from 'maplibre-gl';

const scaleMetersAtZoomZero = 140 * 40075016.686 / 512;
const wideZoom = Math.log2(scaleMetersAtZoomZero / 4000);
const closeZoom = Math.log2(scaleMetersAtZoomZero / 10);

export function transitWidthFactor(zoom: number): number {
  return .8 + .8 * Math.max(0, Math.min(1, (zoom - wideZoom) / (closeZoom - wideZoom)));
}

export function scaledTransitWidth(width: (factor: number) => number | ExpressionSpecification): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], wideZoom, width(.8), closeZoom, width(1.6)];
}
