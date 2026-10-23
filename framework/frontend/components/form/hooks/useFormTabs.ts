import { useMemo } from 'react';

export interface FormFieldDefinition {
  showOn?: string[];
  label?: string;
  [key: string]: any;
}

export interface FieldRef {
  name: string;
  order?: number | null;
  visibleFor?: string[];
}

export interface Section {
  name: string;
  order?: number | null;
  visibleFor?: string[];
  fields: FieldRef[];
  minWidth?: string | null;
  maxWidth?: string | null;
}

export interface Tab {
  name: string;
  order?: number | null;
  visibleFor?: string[];
  sections: Section[];
}

export interface TabInfo {
  label: string;
  order: number;
  sections: Record<string, string[]>;
}

export interface UseFormTabsResult {
  tabs: Record<string, TabInfo>;
  tabList: string[];
  fieldSections: Record<string, string[]>;
}

/**
 * Hook for managing form tabs and field organization.
 *
 * Organizes form fields into tabs and sections based on the hierarchical
 * formTabs structure defined in the schema, sorted by tab/section/field order.
 *
 * Filters tabs, sections, and fields by an opaque `variant` string matched
 * against each item's `visibleFor` array. When `variant` is null/undefined,
 * everything is shown. When an item has no `visibleFor`, it is always shown.
 *
 * @param formTabs - Array of Tab definitions
 * @param activeTab - Currently active tab name
 * @param variant - Optional opaque variant key for filtering (e.g. 'physical', 'virtual', 'admin')
 * @param hiddenTabs - Tab names to drop from the form entirely. Unlike `visibleFor`,
 *   this is the caller's call rather than the schema's: it is for a tab whose fields
 *   must stay in the schema — list columns and filters are generated from them —
 *   while the form itself has no use for them.
 * @param hiddenFields - Field names the caller's role can't see. Dropped from
 *   their section, and a section or tab left with nothing in it goes too: the
 *   server redacts these fields out of the row, so rendering them anyway would
 *   put empty inputs (and empty tabs) in front of the user.
 */
function processFormTabs(
  formTabs: Tab[] | undefined,
  activeTab: string,
  variant?: string | null,
  hiddenTabs?: string[],
  hiddenFields?: string[]
): UseFormTabsResult {
  if (!formTabs || formTabs.length === 0) {
    return { tabs: {}, tabList: [], fieldSections: {} };
  }

  const matchesVariant = (visibleFor?: string[]): boolean => {
    if (!visibleFor || visibleFor.length === 0) return true;
    if (variant === null || variant === undefined) return true;
    return visibleFor.includes(variant);
  };

  const hidden = new Set(hiddenTabs ?? []);
  const hiddenField = new Set(hiddenFields ?? []);
  const filteredTabs = formTabs.filter((tab) => !hidden.has(tab.name) && matchesVariant(tab.visibleFor));

  interface FieldWithOrder {
    name: string;
    order: number;
  }

  interface TabInfoInternal {
    label: string;
    order: number;
    sections: Record<string, { fields: FieldWithOrder[]; order: number }>;
    /** Whether the schema gave this tab any sections — a tab that never had
     *  any draws its content from renderTabContent and must not be pruned. */
    hadSections: boolean;
  }

  const tabsMap: Record<string, TabInfoInternal> = Object.create(null);

  filteredTabs.forEach((tab) => {
    const tabName = tab.name;
    const tabOrder = tab.order ?? 999;

    tabsMap[tabName] = {
      label: tabName,
      order: tabOrder,
      sections: {},
      hadSections: (tab.sections?.length ?? 0) > 0,
    };

    if (tab.sections && Array.isArray(tab.sections)) {
      tab.sections.forEach((section) => {
        if (!matchesVariant(section.visibleFor)) return;

        const sectionName = section.name;
        const sectionOrder = section.order ?? 999;

        tabsMap[tabName].sections[sectionName] = {
          fields: [],
          order: sectionOrder,
        };

        if (section.fields && Array.isArray(section.fields)) {
          section.fields.forEach((fieldRef) => {
            if (!matchesVariant(fieldRef.visibleFor)) return;
            if (hiddenField.has(fieldRef.name)) return;

            const fieldName = fieldRef.name || (typeof fieldRef === 'string' ? fieldRef : null);
            if (!fieldName) {
              console.warn('[useFormTabs] Field reference missing name:', fieldRef);
              return;
            }

            const fieldOrder = fieldRef.order ?? 999;
            tabsMap[tabName].sections[sectionName].fields.push({
              name: fieldName,
              order: fieldOrder,
            });
          });
        }
      });
    }
  });

  const sortedTabsList = Object.entries(tabsMap)
    .sort(([, a], [, b]) => a.order - b.order);

  const sortedTabs: Record<string, TabInfo> = Object.create(null);
  sortedTabsList.forEach(([tabName, tab]) => {
    const sortedSections = Object.entries(tab.sections)
      .sort(([, a], [, b]) => a.order - b.order)
      .reduce((sectionAcc, [sectionName, section]) => {
        const sortedFields = section.fields
          .sort((a, b) => a.order - b.order)
          .map(f => f.name);

        // A section whose every field the role hides is nothing to draw.
        if (sortedFields.length > 0) sectionAcc[sectionName] = sortedFields;
        return sectionAcc;
      }, Object.create(null) as Record<string, string[]>);

    // Likewise a tab: it had sections, and the role can see no field in any of
    // them. (A tab that declares no sections at all is left alone — its content
    // comes from renderTabContent, not from fields.)
    if (Object.keys(sortedSections).length === 0 && tab.hadSections) return;

    sortedTabs[tabName] = {
      label: tab.label,
      order: tab.order ?? 999,
      sections: sortedSections,
    };
  });

  const currentTabSections: Record<string, string[]> = Object.create(null);
  if (sortedTabs[activeTab]) {
    Object.assign(currentTabSections, sortedTabs[activeTab].sections);
  } else if (activeTab && Object.keys(sortedTabs).length > 0) {
    const firstTabName = Object.keys(sortedTabs)[0];
    console.warn(`[useFormTabs] Active tab "${activeTab}" not found, using first tab "${firstTabName}"`);
    Object.assign(currentTabSections, sortedTabs[firstTabName].sections);
  }

  const tabList = Object.entries(sortedTabs)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([tabName]) => tabName);

  return { tabs: sortedTabs, tabList, fieldSections: currentTabSections };
}

export const useFormTabs = (
  formTabs: Tab[] | null | undefined,
  activeTab: string,
  variant?: string | null,
  hiddenTabs?: string[],
  hiddenFields?: string[]
): UseFormTabsResult => {
  // Callers pass a literal (`hiddenTabs={['Image']}`), so a fresh array arrives on
  // every render — key the memo on the contents rather than the identity.
  const hiddenKey = (hiddenTabs ?? []).join('|');
  const hiddenFieldKey = (hiddenFields ?? []).join('|');
  return useMemo(() => {
    return processFormTabs(formTabs || undefined, activeTab, variant, hiddenTabs, hiddenFields);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formTabs, activeTab, variant, hiddenKey, hiddenFieldKey]);
};

export default useFormTabs;
