import citiesByRegion from './cities-by-region.json';

/** The app's existing regional labels; this directory is not a boundary dataset. */
export const ALL_REGION = "Вся Россия";

export const REGIONS: string[] = [
  "Республика Адыгея",
  "Республика Алтай",
  "Республика Башкортостан",
  "Республика Бурятия",
  "Республика Дагестан",
  "Донецкая Народная Республика",
  "Республика Ингушетия",
  "Кабардино-Балкарская Республика",
  "Республика Калмыкия",
  "Карачаево-Черкесская Республика",
  "Республика Карелия",
  "Республика Коми",
  "Республика Крым",
  "Луганская Народная Республика",
  "Республика Марий Эл",
  "Республика Мордовия",
  "Республика Саха (Якутия)",
  "Республика Северная Осетия — Алания",
  "Республика Татарстан",
  "Республика Тыва",
  "Удмуртская Республика",
  "Республика Хакасия",
  "Чеченская Республика",
  "Чувашская Республика",
  "Алтайский край",
  "Забайкальский край",
  "Камчатский край",
  "Краснодарский край",
  "Красноярский край",
  "Пермский край",
  "Приморский край",
  "Ставропольский край",
  "Хабаровский край",
  "Амурская область",
  "Архангельская область",
  "Астраханская область",
  "Белгородская область",
  "Брянская область",
  "Владимирская область",
  "Волгоградская область",
  "Вологодская область",
  "Воронежская область",
  "Запорожская область",
  "Ивановская область",
  "Иркутская область",
  "Калининградская область",
  "Калужская область",
  "Кемеровская область — Кузбасс",
  "Кировская область",
  "Костромская область",
  "Курганская область",
  "Курская область",
  "Ленинградская область",
  "Липецкая область",
  "Магаданская область",
  "Московская область",
  "Мурманская область",
  "Нижегородская область",
  "Новгородская область",
  "Новосибирская область",
  "Омская область",
  "Оренбургская область",
  "Орловская область",
  "Пензенская область",
  "Псковская область",
  "Ростовская область",
  "Рязанская область",
  "Самарская область",
  "Саратовская область",
  "Сахалинская область",
  "Свердловская область",
  "Смоленская область",
  "Тамбовская область",
  "Тверская область",
  "Томская область",
  "Тульская область",
  "Тюменская область",
  "Ульяновская область",
  "Херсонская область",
  "Челябинская область",
  "Ярославская область",
  "Москва",
  "Санкт-Петербург",
  "Севастополь",
  "Еврейская автономная область",
  "Ненецкий автономный округ",
  "Ханты-Мансийский автономный округ — Югра",
  "Чукотский автономный округ",
  "Ямало-Ненецкий автономный округ",
].sort((a, b) => a.localeCompare(b, "ru"));

/** All city entries of the pinned source, mapped to the app's 89 regional labels. */
export const CITIES_BY_REGION: Readonly<Record<string, readonly string[]>> = citiesByRegion;

export const DIRECTORY_META = {
  source: 'https://github.com/Alex56dev/russian_cities',
  sourceDate: '2026-04',
  verifiedAt: '2026-11-09',
  sourceBlobSha: 'cdeb06bbd940d974f773c5db0be8730eca5686f2',
  regionCount: REGIONS.length,
  cityCount: Object.values(CITIES_BY_REGION).reduce((total, cities) => total + cities.length, 0),
} as const;

export function getCities(region: string): readonly string[] {
  return CITIES_BY_REGION[region] || [];
}

/** Empty city means the entire region. Country-wide events use the existing label. */
export function isValidLocation(region: string, city: string): boolean {
  if (region === ALL_REGION) return city === '' || city === ALL_REGION;
  return REGIONS.includes(region) && (city === '' || getCities(region).includes(city));
}

export function normalizeLocationSearch(value: string): string {
  return value.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[—–-]/g, ' ').replace(/\s+/g, ' ');
}

export function locationLabel(region: string, city?: string): string {
  return city && city !== ALL_REGION ? city : region;
}
