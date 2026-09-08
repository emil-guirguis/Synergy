import { useState, useEffect, useCallback, useMemo } from 'react';
import type { SearchFilterProps, AdvancedFilterProps } from '../list/types/ui';
import './SearchFilter.css';

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

function AdvancedFilter({ filters, values, onChange, onReset }: AdvancedFilterProps) {
  const handleFilterChange = useCallback((key: string, value: any) => {
    onChange({
      ...values,
      [key]: value
    });
  }, [values, onChange]);

  const handleClearFilter = useCallback((key: string) => {
    const newValues = { ...values };
    delete newValues[key];
    onChange(newValues);
  }, [values, onChange]);

  const activeFiltersCount = Object.keys(values).length;

  return (
    <div className="advanced-filter">
      <div className="advanced-filter__header">
        <h3 className="advanced-filter__title">Advanced Filters</h3>
        {activeFiltersCount > 0 && (
          <button
            type="button"
            className="advanced-filter__reset"
            onClick={onReset}
          >
            Clear All ({activeFiltersCount})
          </button>
        )}
      </div>

      <div className="advanced-filter__grid">
        {filters.map((filter) => (
          <div key={filter.key} className="advanced-filter__field">
            <label className="advanced-filter__label">
              {filter.label}
            </label>
            
            {filter.type === 'text' && (
              <div className="advanced-filter__input-group">
                <input
                  type="text"
                  className="advanced-filter__input"
                  placeholder={filter.placeholder}
                  value={values[filter.key] || ''}
                  onChange={(e) => handleFilterChange(filter.key, e.target.value)}
                />
                {values[filter.key] && (
                  <button
                    type="button"
                    className="advanced-filter__clear"
                    onClick={() => handleClearFilter(filter.key)}
                    aria-label={`Clear ${filter.label}`}
                  >
                    ✕
                  </button>
                )}
              </div>
            )}

            {filter.type === 'select' && (
              <div className="advanced-filter__input-group">
                <select
                  className="advanced-filter__select"
                  value={values[filter.key] || ''}
                  onChange={(e) => handleFilterChange(filter.key, e.target.value)}
                  aria-label={filter.label}
                >
                  <option value="">All {filter.label}</option>
                  {filter.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {values[filter.key] && (
                  <button
                    type="button"
                    className="advanced-filter__clear"
                    onClick={() => handleClearFilter(filter.key)}
                    aria-label={`Clear ${filter.label}`}
                  >
                    ✕
                  </button>
                )}
              </div>
            )}

            {filter.type === 'date' && (
              <div className="advanced-filter__input-group">
                <input
                  type="date"
                  className="advanced-filter__input"
                  value={values[filter.key] || ''}
                  onChange={(e) => handleFilterChange(filter.key, e.target.value)}
                  aria-label={filter.label}
                />
                {values[filter.key] && (
                  <button
                    type="button"
                    className="advanced-filter__clear"
                    onClick={() => handleClearFilter(filter.key)}
                    aria-label={`Clear ${filter.label}`}
                  >
                    ✕
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SearchFilter({
  placeholder = 'Search...',
  filters = [],
  onSearch,
  onFilter,
  onClear,
  loading = false,
  showAdvanced = true,
  className = '',
}: SearchFilterProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterValues, setFilterValues] = useState<Record<string, any>>({});
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [isSearchFocused, setIsSearchFocused] = useState(false);

  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  useEffect(() => {
    onSearch(debouncedSearchQuery);
  }, [debouncedSearchQuery, onSearch]);

  useEffect(() => {
    onFilter(filterValues);
  }, [filterValues, onFilter]);

  const handleSearchChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
  }, []);

  const handleSearchClear = useCallback(() => {
    setSearchQuery('');
  }, []);

  const handleFilterChange = useCallback((newFilters: Record<string, any>) => {
    setFilterValues(newFilters);
  }, []);

  const handleFilterReset = useCallback(() => {
    setFilterValues({});
  }, []);

  const handleClearAll = useCallback(() => {
    setSearchQuery('');
    setFilterValues({});
    onClear();
  }, [onClear]);

  const toggleAdvancedFilters = useCallback(() => {
    setShowAdvancedFilters(!showAdvancedFilters);
  }, [showAdvancedFilters]);

  const activeFiltersCount = useMemo(() => {
    return Object.keys(filterValues).filter(key => {
      const value = filterValues[key];
      return value !== '' && value !== null && value !== undefined && value !== false;
    }).length;
  }, [filterValues]);

  const hasActiveSearchOrFilter = searchQuery.trim() !== '' || activeFiltersCount > 0;

  return (
    <div className={`search-filter ${className}`}>
      <div className="search-filter__main">
        <div className={`
          search-filter__search-group
          ${isSearchFocused ? 'search-filter__search-group--focused' : ''}
          ${loading ? 'search-filter__search-group--loading' : ''}
        `.trim()}>
          <div className="search-filter__search-icon">
            {loading ? (
              <div className="search-filter__spinner"></div>
            ) : (
              <span>🔍</span>
            )}
          </div>
          
          <input
            type="text"
            className="search-filter__search-input"
            placeholder={placeholder}
            value={searchQuery}
            onChange={handleSearchChange}
            onFocus={() => setIsSearchFocused(true)}
            onBlur={() => setIsSearchFocused(false)}
            disabled={loading}
          />
          
          {searchQuery && (
            <button
              type="button"
              className="search-filter__search-clear"
              onClick={handleSearchClear}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        <div className="search-filter__controls">
          {showAdvanced && filters.length > 0 && (
            <button
              type="button"
              className={`
                search-filter__filter-toggle
                ${showAdvancedFilters ? 'search-filter__filter-toggle--active' : ''}
              `.trim()}
              onClick={toggleAdvancedFilters}
            >
              <span className="search-filter__filter-icon">⚙️</span>
              Filters
              {activeFiltersCount > 0 && (
                <span className="search-filter__filter-badge">
                  {activeFiltersCount}
                </span>
              )}
            </button>
          )}

          {hasActiveSearchOrFilter && (
            <button
              type="button"
              className="search-filter__clear-all"
              onClick={handleClearAll}
            >
              Clear All
            </button>
          )}
        </div>
      </div>

      {showAdvanced && showAdvancedFilters && filters.length > 0 && (
        <div className="search-filter__advanced">
          <AdvancedFilter
            filters={filters}
            values={filterValues}
            onChange={handleFilterChange}
            onReset={handleFilterReset}
          />
        </div>
      )}
    </div>
  );
}
