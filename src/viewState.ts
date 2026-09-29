import type { SortMode } from './tree'

export type ViewLayout = 'tree' | 'flat'
export type { SortMode }

export interface ViewOptions {
  layout: ViewLayout
  sortMode: SortMode
  hideUnchanged: boolean
}

export const defaultViewOptions: ViewOptions = {
  layout: 'tree',
  sortMode: 'name',
  hideUnchanged: false,
}

export function loadViewOptions(raw: Partial<ViewOptions> | undefined): ViewOptions {
  return {
    layout: raw?.layout === 'flat' ? 'flat' : 'tree',
    sortMode: raw?.sortMode === 'wip' ? 'wip' : 'name',
    hideUnchanged: raw?.hideUnchanged === true,
  }
}
