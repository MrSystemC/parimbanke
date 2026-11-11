'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, MapPin, Search, X } from 'lucide-react';
import { ALL_REGION, DIRECTORY_META, REGIONS, getCities, normalizeLocationSearch } from '@/lib/regions';
import './location-picker.css';

type LocationPickerProps = {
  region: string;
  city?: string;
  onSelect: (region: string, city: string) => void;
};

export function LocationPicker({ region, city = '', onSelect }: LocationPickerProps) {
  const [browseRegion, setBrowseRegion] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const normalized = normalizeLocationSearch(query);
  const regions = REGIONS.filter(item => normalizeLocationSearch(item).includes(normalized));
  const cityMatches = useMemo(() => {
    const scope = browseRegion ? [browseRegion] : REGIONS;
    if (!browseRegion && !normalized) return [];
    return scope.flatMap(item => getCities(item)
      .filter(name => normalizeLocationSearch(name).includes(normalized))
      .map(name => ({ region: item, city: name })))
      .sort((a, b) => a.city.localeCompare(b.city, 'ru') || a.region.localeCompare(b.region, 'ru'));
  }, [browseRegion, normalized]);

  function openRegion(value: string) { setBrowseRegion(value); setQuery(''); }
  return <div className="location-picker">
    <div className="location-current"><MapPin size={15} /><span>Сейчас: <strong>{city || region}</strong>{city && region !== city && <small> · {region}</small>}</span></div>
    <label className="search-box region-search location-search"><Search size={18} /><input autoFocus aria-label={browseRegion ? 'Поиск города в регионе' : 'Поиск региона или города'} placeholder={browseRegion ? 'Найти город в регионе' : 'Название региона или города'} value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="Очистить поиск" onClick={() => setQuery('')}><X size={16}/></button>}</label>
    {browseRegion ? <>
      <button type="button" className="location-back" onClick={() => { setBrowseRegion(null); setQuery(''); }}><ArrowLeft size={15}/>Все регионы</button>
      <div className="location-region-heading"><strong>{browseRegion}</strong><span>В справочнике: {getCities(browseRegion).length}</span></div>
      <button type="button" className={`region-option all-regions ${region === browseRegion && !city ? 'chosen' : ''}`} onClick={() => onSelect(browseRegion, '')}><span><MapPin size={17}/>Все города региона</span>{region === browseRegion && !city && <Check size={17}/>}</button>
    </> : <button type="button" className={`region-option all-regions ${region === ALL_REGION ? 'chosen' : ''}`} onClick={() => onSelect(ALL_REGION, '')}><span><MapPin size={18}/>{ALL_REGION}</span>{region === ALL_REGION && <Check size={18}/>}</button>}
    <div className="region-list location-results" aria-live="polite">
      {!browseRegion && regions.length > 0 && <>
        <p className="location-section-label">РЕГИОНЫ{normalized && ` · ${regions.length}`}</p>
        {regions.map(item => <button type="button" key={item} className={`region-option location-region ${region === item ? 'chosen' : ''}`} onClick={() => openRegion(item)}><span>{item}<small>В справочнике: {getCities(item).length}</small></span><ChevronRight size={17}/></button>)}
      </>}
      {cityMatches.length > 0 && <>
        <p className="location-section-label">ГОРОДА · {cityMatches.length}</p>
        {cityMatches.map(item => <button type="button" key={`${item.region}/${item.city}`} className={`region-option location-city ${region === item.region && city === item.city ? 'chosen' : ''}`} onClick={() => onSelect(item.region, item.city)}><span>{item.city}{!browseRegion && <small>{item.region}</small>}</span>{region === item.region && city === item.city && <Check size={17}/>}</button>)}
      </>}
      {(browseRegion ? cityMatches.length === 0 : regions.length === 0 && cityMatches.length === 0) && <p className="panel-empty">Ничего не найдено. Проверьте название или выберите другой регион.</p>}
    </div>
    <p className="location-directory-note">{DIRECTORY_META.regionCount} регионов · {DIRECTORY_META.cityCount.toLocaleString('ru-RU')} городов и городских территорий · апрель 2026</p>
  </div>;
}

type RegionCityFieldsProps = { defaultRegion?: string; defaultCity?: string; disabled?: boolean };

/** Controls are named region/city and can be read with FormData in the parent form. */
export function RegionCityFields({ defaultRegion = ALL_REGION, defaultCity = '', disabled = false }: RegionCityFieldsProps) {
  const [region, setRegion] = useState(REGIONS.includes(defaultRegion) ? defaultRegion : ALL_REGION);
  const [city, setCity] = useState(defaultRegion === ALL_REGION ? ALL_REGION : defaultCity);
  const cities = getCities(region);
  const legacyCity = city && city !== ALL_REGION && !cities.includes(city);
  return <>
    <label>Регион<select name="region" disabled={disabled} value={region} onChange={event => { const value = event.target.value; setRegion(value); setCity(value === ALL_REGION ? ALL_REGION : ''); }}><option value={ALL_REGION}>{ALL_REGION}</option>{REGIONS.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
    <label>Город<select name="city" disabled={disabled} value={region === ALL_REGION ? ALL_REGION : city} onChange={event => setCity(event.target.value)}>{region === ALL_REGION ? <option value={ALL_REGION}>Вся Россия</option> : <><option value="">Все города региона</option>{legacyCity && <option value={city}>{city} · сохранённое значение</option>}{cities.map(item => <option key={item} value={item}>{item}</option>)}</>}</select><small>{region === ALL_REGION ? 'Розыгрыш доступен во всех регионах.' : 'Выберите город из справочника или весь регион.'}</small></label>
  </>;
}
