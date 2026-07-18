import { describe, it, expect } from 'vitest';
import { getWeatherIconSVG, getSunnySVG, getCloudySVG, getRainySVG, getThunderSVG, getSnowySVG } from './main';

describe('Weather UI Utilities', () => {
  it('should return sunny SVG for clear codes (0)', () => {
    expect(getWeatherIconSVG(0)).toBe(getSunnySVG());
  });

  it('should return cloudy SVG for cloudy codes (1, 2, 3)', () => {
    expect(getWeatherIconSVG(1)).toBe(getCloudySVG());
    expect(getWeatherIconSVG(2)).toBe(getCloudySVG());
    expect(getWeatherIconSVG(3)).toBe(getCloudySVG());
  });

  it('should return rainy SVG for rain/drizzle codes', () => {
    expect(getWeatherIconSVG(51)).toBe(getRainySVG());
    expect(getWeatherIconSVG(63)).toBe(getRainySVG());
    expect(getWeatherIconSVG(80)).toBe(getRainySVG());
  });

  it('should return snowy SVG for snow codes', () => {
    expect(getWeatherIconSVG(71)).toBe(getSnowySVG());
    expect(getWeatherIconSVG(85)).toBe(getSnowySVG());
  });

  it('should return thunder SVG for thunderstorm codes', () => {
    expect(getWeatherIconSVG(95)).toBe(getThunderSVG());
    expect(getWeatherIconSVG(99)).toBe(getThunderSVG());
  });

  it('should return sunny SVG for unknown codes or null', () => {
    expect(getWeatherIconSVG(999)).toBe(getSunnySVG());
    expect(getWeatherIconSVG(null)).toBe(getSunnySVG());
    expect(getWeatherIconSVG(undefined)).toBe(getSunnySVG());
  });
});
