export const DEFAULT_CATEGORIES = ['Электроника', 'Для дома', 'Хобби и отдых'];
export const MAX_CUSTOM_CATEGORIES = 100;

export function cleanCategoryName(value:string):string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function categoryKey(value:string):string {
  return cleanCategoryName(value).toLocaleLowerCase('ru').replace(/ё/g, 'е');
}
