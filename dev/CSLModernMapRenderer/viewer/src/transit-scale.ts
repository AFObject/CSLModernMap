import type {ExpressionSpecification} from 'maplibre-gl';

const scaleMetersAtZoomZero = 140 * 40075016.686 / 512;
const wideZoom = Math.log2(scaleMetersAtZoomZero / 5000);
const closeZoom = Math.log2(scaleMetersAtZoomZero / 10);
const wideFactor = .7, closeFactor = 2.1;

export function transitWidthFactor(zoom: number): number {
  return wideFactor + (closeFactor - wideFactor) * Math.max(0, Math.min(1, (zoom - wideZoom) / (closeZoom - wideZoom)));
}

export function scaledTransitWidth(width: (factor: number) => number | ExpressionSpecification): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], wideZoom, width(wideFactor), closeZoom, width(closeFactor)];
}
