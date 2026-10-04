/** 属性设置里给人看的说明：类型、左侧栏、内置属性的限制。 */
import type { PropertyType } from '@shared/constants';

/** 新建属性时每种类型的说明 */
export const PROPERTY_TYPE_HINTS: Record<PropertyType, string> = {
  select: '每题选一个，例如难度、题型',
  multiselect: '可以选好几个，例如考点',
  text: '一段文字，例如出处、教材版本',
  number: '一个数，例如年份、分值',
  date: '一个日期，例如考试日期',
  checkbox: '是或否，例如“重点”',
};

export const NAV_HINT = '在左侧栏列出它的选项和数量，点一下即可按它筛选；也可以把题目拖到选项上来设置';
/** 内置属性（题型、难度、考点）不能归档、不能改类型的原因 */
export const PRESET_ARCHIVE_HINT = '内置属性不能归档；不想在左侧栏看到它，可以取消“在左侧栏列出”';
export const PRESET_TYPE_HINT = '内置属性不能改类型';

export const isOptionType = (t: PropertyType) => t === 'select' || t === 'multiselect';
/** 能在左侧栏列出的类型 */
export const isNavType = (t: PropertyType) => isOptionType(t) || t === 'checkbox';
