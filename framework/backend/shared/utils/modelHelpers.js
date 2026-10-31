/**
 * Model Helpers Utility Module
 * 
 * Provides utilities for dynamic CRUD generation including:
 * - Field extraction from model constructors
 * - SQL statement generation (INSERT, SELECT, UPDATE, DELETE)
 * - WHERE clause building with operators
 * - JOIN clause generation for relationships
 * - Type mapping and validation
 */

const { log } = require('console');
const {
  serializeValue,
  deserializeRow
} = require('./typeHandlers');

/**
 * Extract field definitions from a model class constructor
 * Parses the constructor source code to identify field assignments
 * 
 * @param {Function} ModelClass - The model class to extract fields from
 * @returns {Array<Object>} Array of field metadata objects
 */
function extractFields(ModelClass) {
  // Check if fields are already cached
  // @ts-ignore - Dynamic property for caching
  if (ModelClass._cachedFields) {
    // @ts-ignore - Dynamic property for caching
    return ModelClass._cachedFields;
  }

  const fields = [];
  const constructorStr = ModelClass.prototype.constructor.toString();
  
  // Match patterns like: this.fieldName = data.fieldName
  // Also handles: this.fieldName = data.fieldName || 'default'
  const fieldPattern = /this\.(\w+)\s*=\s*(?:data|meterData|\w+Data)\.(\w+)/g;
  let match;
  
  while ((match = fieldPattern.exec(constructorStr)) !== null) {
    const fieldName = match[1];
    
    // Skip if already added (can happen with complex assignments)
    if (fields.find(f => f.name === fieldName)) {
      continue;
    }
    
    // Determine if this is a special field
    const isPrimaryKey = fieldName === 'id';
    const isForeignKey = fieldName.endsWith('_id');
    const isTimestamp = fieldName === 'created_at' || fieldName === 'updated_at';
    
    fields.push({
      name: fieldName,
      column: fieldName, // Default: same as property name
      type: inferType(fieldName),
      sqlType: inferSQLType(fieldName),
      nullable: !isPrimaryKey,
      defaultValue: null,
      isPrimaryKey,
      isForeignKey,
      isTimestamp
    });
  }
  
  // Cache the extracted fields
  // @ts-ignore - Dynamic property for caching
  ModelClass._cachedFields = fields;
  
  return fields;
}

/**
 * Infer JavaScript type from field name
 * @param {string} fieldName - The field name
 * @returns {string} JavaScript type
 */
function inferType(fieldName) {
  if (fieldName === 'id' || fieldName.endsWith('_id')) {
    return 'number';
  }
  if (fieldName.includes('date') || fieldName.includes('_at')) {
    return 'Date';
  }
  if (fieldName.includes('is_') || fieldName.includes('has_')) {
    return 'boolean';
  }
  if (fieldName.endsWith('_map') || fieldName.endsWith('_data') || fieldName.endsWith('_config')) {
    return 'Object';
  }
  return 'string';
}

/**
 * Infer SQL type from field name
 * @param {string} fieldName - The field name
 * @returns {string} SQL type
 */
function inferSQLType(fieldName) {
  if (fieldName === 'id' || fieldName.endsWith('_id')) {
    return 'INTEGER';
  }
  if (fieldName.includes('date') || fieldName.includes('_at')) {
    return 'TIMESTAMP';
  }
  if (fieldName.includes('is_') || fieldName.includes('has_')) {
    return 'BOOLEAN';
  }
  if (fieldName.endsWith('_map') || fieldName.endsWith('_data') || fieldName.endsWith('_config')) {
    return 'JSONB';
  }
  if (fieldName === 'notes' || fieldName === 'description') {
    return 'TEXT';
  }
  return 'VARCHAR';
}

/**
 * Build INSERT SQL statement
 * 
 * @param {string} tableName - The table name
 * @param {Array<Object>} fields - Field metadata
 * @param {Object} data - Data to insert
 * @param {Object} context - Optional context with tenant_id for auto-injection
 * @returns {Object} { sql, values } - SQL query and parameter values
 */
function buildInsertSQL(tableName, fields, data, context = {}) {
  const columns = [];
  const placeholders = [];
  const values = [];
  let paramIndex = 1;
  
  // Create a map of field names to field metadata for quick lookup
  const fieldMap = new Map();
  fields.forEach(field => {
    fieldMap.set(field.name, field);
  });
  
  // Add provided fields
  for (const [key, value] of Object.entries(data)) {
    // Skip undefined values and id if it's null/undefined (auto-increment)
    if (value === undefined || (key === 'id' && (value === null || value === undefined))) {
      continue;
    }

    const field = fieldMap.get(key);
    const fieldType = field ? field.type : null;

    // Skip read-only fields with null/undefined values (auto-generated: PKs, timestamps)
    // Read-only fields WITH a value are still inserted (e.g. is_virtual set during creation)
    if (field && field.readOnly && (value === null || value === undefined)) {
      continue;
    }

    // Skip fields with no database column (computed fields)
    if (field && field.dbField === null) {
      continue;
    }
    
    // Use the database column name (field.column or field.dbField), not the property name
    const columnName = field ? (field.column || field.dbField || key) : key;
    
    columns.push(columnName);
    placeholders.push(`$${paramIndex++}`);
    values.push(serializeValue(value, fieldType));
  }
  
  // Add timestamps if not provided
  const hasCreatedAt = columns.includes('created_at');
  const hasUpdatedAt = columns.includes('updated_at');
  const hasTenantId = columns.includes('tenant_id');
  
  if (!hasCreatedAt && fields.some(f => f.name === 'created_at')) {
    columns.push('created_at');
    placeholders.push('CURRENT_TIMESTAMP');
  }
  
  if (!hasUpdatedAt && fields.some(f => f.name === 'updated_at')) {
    columns.push('updated_at');
    placeholders.push('CURRENT_TIMESTAMP');
  }
  
  // Auto-inject tenant_id if it's a field in the model and not already provided
  if (!hasTenantId && fields.some(f => f.name === 'tenant_id')) {
    // tenant_id is a field but not provided - this will fail
    console.error(`✗ ERROR: tenant_id field exists but was not provided in data for ${tableName}`);
    console.error('Data provided:', Object.keys(data));
    console.error('This will cause a foreign key constraint error');
  }
  
  const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
  
  
  return { sql, values };
}

/**
 * Build SELECT SQL statement
 * 
 * @param {string} tableName - The table name
 * @param {Array<Object>} fields - Field metadata
 * @param {Object} options - Query options (where, include, order, limit, offset, attributes)
 * @returns {Object} { sql, values, relationshipMap } - SQL query, parameter values, and relationship mapping
 */
function buildSelectSQL(tableName, fields, options = {}) {
  const { where, include, order, limit, offset, attributes } = options;
  
  // Build SELECT clause
  let selectClause;
  if (attributes && attributes.length > 0) {
    selectClause = attributes.map((/** @type {any} */ attr) => `${tableName}.${attr}`).join(', ');
  } else {
    selectClause = `${tableName}.*`;
  }
  
  // Build JOIN clause
  let joinClause = '';
  let relationshipMap = [];
  if (include && include.length > 0) {
    const joinResult = buildJoinClause(tableName, include, options.relationships || {});
    joinClause = joinResult.clause;
    selectClause += joinResult.selectAdditions;
    relationshipMap = joinResult.relationshipMap;
  }
  
  // Build WHERE clause
  let whereClause = '';
  let values = [];
  if (where && Object.keys(where).length > 0) {
    const whereResult = buildWhereClause(where, tableName, 1, fields);
    whereClause = ` WHERE ${whereResult.clause}`;
    values = whereResult.values;
  }
  
  // Build ORDER BY clause
  let orderClause = '';
  if (order && order.length > 0) {
    const orderParts = order.map(([field, direction]) => {
      const dir = direction.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      return `${tableName}.${field} ${dir}`;
    });
    orderClause = ` ORDER BY ${orderParts.join(', ')}`;
  }
  
  // Build LIMIT and OFFSET clauses
  let limitClause = '';
  if (limit) {
    limitClause = ` LIMIT ${parseInt(limit, 10)}`;
  }
  
  let offsetClause = '';
  if (offset) {
    offsetClause = ` OFFSET ${parseInt(offset, 10)}`;
  }
  
  const sql = `SELECT ${selectClause} FROM ${tableName}${joinClause}${whereClause}${orderClause}${limitClause}${offsetClause}`;
  
  
  return { sql, values, relationshipMap };
}

/**
 * Build UPDATE SQL statement
 * 
 * @param {string} tableName - The table name
 * @param {Array<Object>} fields - Field metadata
 * @param {Object} data - Data to update
 * @param {Object} where - WHERE conditions
 * @returns {Object} { sql, values } - SQL query and parameter values
 */
function buildUpdateSQL(tableName, fields, data, where) {
  const setClauses = [];
  const values = [];
  let paramIndex = 1;
  
  // Create a map of field names to field metadata for quick lookup
  const fieldMap = new Map();
  fields.forEach(field => {
    fieldMap.set(field.name, field);
  });
  
  // Add provided fields to SET clause
  for (const [key, value] of Object.entries(data)) {
    // Skip undefined values and primary key
    if (value === undefined || key === 'id') {
      continue;
    }
    
    const field = fieldMap.get(key);
    const fieldType = field ? field.type : null;
    
    // Skip read-only fields
    if (field && field.readOnly) {
      continue;
    }
    
    // Skip fields with no database column (computed fields)
    if (field && field.dbField === null) {
      continue;
    }
    
    // Use the database column name (field.column or field.dbField), not the property name
    const columnName = field ? (field.column || field.dbField || key) : key;
    
    setClauses.push(`${columnName} = $${paramIndex++}`);
    values.push(serializeValue(value, fieldType));
  }
  
  // Automatically update updated_at timestamp
  if (fields.some(f => f.name === 'updated_at') && !data.updated_at) {
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
  }
  
  if (setClauses.length === 0) {
    throw new Error('No fields to update');
  }
  
  // Build WHERE clause
  const whereResult = buildWhereClause(where, tableName, paramIndex, fields);
  values.push(...whereResult.values);
  
  const sql = `UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE ${whereResult.clause} RETURNING *`;
  
  
  return { sql, values };
}

/**
 * Build DELETE SQL statement
 * 
 * @param {string} tableName - The table name
 * @param {Object} where - WHERE conditions
 * @param {Array<Object>} fields - Optional field metadata for dbField lookup
 * @returns {Object} { sql, values } - SQL query and parameter values
 */
function buildDeleteSQL(tableName, where, fields, doDeactivate) {
  const whereResult = buildWhereClause(where, tableName, 1, fields);
  
  let sql = ``;
  if (doDeactivate) { sql = `UPDATE ${tableName} set active = false WHERE ${whereResult.clause} RETURNING *`;}
  else { sql = `DELETE FROM ${tableName} WHERE ${whereResult.clause} RETURNING *`;};
  
  return { sql, values: whereResult.values };
}

/**
 * Build WHERE clause from conditions object
 * Supports operators: eq, ne, gt, gte, lt, lte, like, in, between
 * 
 * @param {Object} conditions - WHERE conditions
 * @param {string} tableName - Table name for prefixing columns
 * @param {number} paramOffset - Starting parameter index
 * @param {Array<Object>|null} fields - Optional field metadata for dbField lookup
 * @returns {Object} { clause, values } - WHERE clause and parameter values
 */
function buildWhereClause(conditions, tableName = '', paramOffset = 1, fields = null) {
  const clauses = [];
  const values = [];
  let paramIndex = paramOffset;
  
  const prefix = tableName ? `${tableName}.` : '';
  
  // Create a map of field names to field metadata for quick lookup
  const fieldMap = new Map();
  // Also create a reverse map of dbField to field metadata
  const dbFieldMap = new Map();
  if (fields && Array.isArray(fields)) {
    fields.forEach(field => {
      fieldMap.set(field.name, field);
      // If the field has a dbField property, also map by dbField
      if (field.dbField) {
        dbFieldMap.set(field.dbField, field);
      }
    });
  }
  
  for (const [field, condition] of Object.entries(conditions)) {
    // Look up the field definition to get the dbField property
    // First try direct field name lookup, then try dbField lookup
    let fieldDef = fieldMap.get(field);
    if (!fieldDef && dbFieldMap.has(field)) {
      fieldDef = dbFieldMap.get(field);
    }
    const columnName = fieldDef && fieldDef.dbField ? fieldDef.dbField : field;
    if (condition === null) {
      clauses.push(`${prefix}${columnName} IS NULL`);
    } else if (typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
      // Handle operator objects (but not Date objects)
      for (const [operator, value] of Object.entries(condition)) {
        switch (operator) {
          case 'eq':
            clauses.push(`${prefix}${columnName} = $${paramIndex++}`);
            values.push(serializeValue(value));
            break;
          case 'ne':
            clauses.push(`${prefix}${columnName} != $${paramIndex++}`);
            values.push(serializeValue(value));
            break;
          case 'gt':
            clauses.push(`${prefix}${columnName} > $${paramIndex++}`);
            values.push(serializeValue(value));
            break;
          case 'gte':
            clauses.push(`${prefix}${columnName} >= $${paramIndex++}`);
            values.push(serializeValue(value));
            break;
          case 'lt':
            clauses.push(`${prefix}${columnName} < $${paramIndex++}`);
            values.push(serializeValue(value));
            break;
          case 'lte':
            clauses.push(`${prefix}${columnName} <= $${paramIndex++}`);
            values.push(serializeValue(value));
            break;
          case 'like':
            clauses.push(`${prefix}${columnName} LIKE $${paramIndex++}`);
            values.push(serializeValue(value));
            break;
          case 'in':
            if (!Array.isArray(value) || value.length === 0) {
              throw new Error(`'in' operator requires non-empty array for field ${field}`);
            }
            const inPlaceholders = value.map(() => `$${paramIndex++}`).join(', ');
            clauses.push(`${prefix}${columnName} IN (${inPlaceholders})`);
            values.push(...value.map(v => serializeValue(v)));
            break;
          case 'between':
            if (!Array.isArray(value) || value.length !== 2) {
              throw new Error(`'between' operator requires array of 2 values for field ${field}`);
            }
            clauses.push(`${prefix}${columnName} BETWEEN $${paramIndex++} AND $${paramIndex++}`);
            values.push(serializeValue(value[0]), serializeValue(value[1]));
            break;
          default:
            throw new Error(`Unsupported operator: ${operator}`);
        }
      }
    } else {
      // Simple equality
      clauses.push(`${prefix}${columnName} = $${paramIndex++}`);
      values.push(serializeValue(condition));
    }
  }
  
  const clause = clauses.join(' AND ');
  
  return { clause, values };
}

/**
 * Build JOIN clause for relationships with proper column aliasing
 * Supports nested includes (e.g., ['device', 'location', { user: ['profile'] }])
 * 
 * @param {string} tableName - Main table name
 * @param {Array<string|Object>} includes - Array of relationship names or objects with nested includes
 * @param {Object} relationships - Relationship configuration
 * @param {string|null} parentAlias - Parent table alias for nested joins
 * @returns {Object} { clause, selectAdditions, relationshipMap } - JOIN clause, SELECT fields, and mapping info
 */
function buildJoinClause(tableName, includes, relationships, parentAlias = null) {
  const joinClauses = [];
  const selectAdditions = [];
  const relationshipMap = [];
  
  if (!includes || includes.length === 0) {
    return { clause: '', selectAdditions: '', relationshipMap: [] };
  }
  
  for (const include of includes) {
    let includeName;
    let nestedIncludes = [];
    
    // Handle nested includes: { relationName: ['nestedRelation1', 'nestedRelation2'] }
    if (typeof include === 'object' && !Array.isArray(include)) {
      includeName = Object.keys(include)[0];
      nestedIncludes = include[includeName];
    } else {
      includeName = include;
    }
    
    const relationship = relationships[includeName];
    
    if (!relationship) {
      throw new Error(`Relationship '${includeName}' not defined in ${tableName}`);
    }
    
    const { type, model, foreignKey, targetKey, as } = relationship;
    const alias = as || includeName;
    const relatedTable = model.toLowerCase();
    const sourceTable = parentAlias || tableName;
    
    // Store relationship mapping for later data transformation
    relationshipMap.push({
      name: includeName,
      alias,
      type,
      relatedTable,
      foreignKey,
      targetKey,
      nestedIncludes
    });
    
    switch (type) {
      case 'belongsTo':
        // Foreign key is in the current table
        // Example: meter.device_id -> device.device_id
        joinClauses.push(
          ` LEFT JOIN ${relatedTable} AS ${alias} ON ${sourceTable}.${foreignKey} = ${alias}.${targetKey}`
        );
        
        // Use row_to_json to get all related columns as a JSON object
        // This makes it easy to separate main table data from related data
        selectAdditions.push(`, row_to_json(${alias}) AS ${alias}_data`);
        break;
        
      case 'hasOne':
        // Foreign key is in the related table (one-to-one)
        // Example: user.id -> profile.user_id
        joinClauses.push(
          ` LEFT JOIN ${relatedTable} AS ${alias} ON ${sourceTable}.${targetKey} = ${alias}.${foreignKey}`
        );
        
        selectAdditions.push(`, row_to_json(${alias}) AS ${alias}_data`);
        break;
        
      case 'hasMany':
        // Foreign key is in the related table (one-to-many)
        // Note: This will duplicate parent rows - needs special handling
        // For now, we'll join but the mapping function will need to aggregate
        joinClauses.push(
          ` LEFT JOIN ${relatedTable} AS ${alias} ON ${sourceTable}.${targetKey} = ${alias}.${foreignKey}`
        );
        
        selectAdditions.push(`, row_to_json(${alias}) AS ${alias}_data`);
        break;
        
      default:
        throw new Error(`Unsupported relationship type: ${type}`);
    }
    
    // Handle nested includes recursively
    if (nestedIncludes && nestedIncludes.length > 0) {
      // We need to get the relationships for the related model
      // For now, we'll skip nested includes as it requires model registry
      // This can be enhanced in the future
      console.warn(`Nested includes for '${includeName}' are not yet fully supported`);
    }
  }
  
  return {
    clause: joinClauses.join(''),
    selectAdditions: selectAdditions.join(''),
    relationshipMap
  };
}

/**
 * Map joined database results to nested objects
 * Transforms flat joined rows with JSON columns into objects with nested relationship data
 * 
 * @param {Array<Object>} rows - Database result rows with relationship data as JSON
 * @param {Array<Object>} relationshipMap - Relationship mapping info from buildJoinClause
 * @param {string} primaryKey - Primary key of the main table
 * @returns {Array<Object>} Rows with nested relationship objects
 */
function mapJoinedResults(rows, relationshipMap, primaryKey = 'id') {
  if (!rows || rows.length === 0 || !relationshipMap || relationshipMap.length === 0) {
    return rows;
  }
  
  // Group rows by primary key to handle hasMany relationships
  const groupedRows = new Map();
  
  for (const row of rows) {
    const mainId = row[primaryKey];
    
    if (!groupedRows.has(mainId)) {
      // Create main object with only main table fields
      const mainObject = {};
      
      // Copy all main table fields (exclude relationship data fields)
      for (const [key, value] of Object.entries(row)) {
        // Skip relationship data fields (they end with _data)
        if (!key.endsWith('_data')) {
          mainObject[key] = value;
        }
      }
      
      groupedRows.set(mainId, { main: mainObject, relationships: {} });
    }
    
    // Extract relationship data
    const grouped = groupedRows.get(mainId);
    
    for (const rel of relationshipMap) {
      const dataKey = `${rel.alias}_data`;
      const relatedData = row[dataKey];
      
      // Check if we have valid related data (not null and has at least one non-null value)
      if (relatedData && typeof relatedData === 'object') {
        const hasData = Object.values(relatedData).some(v => v !== null);
        
        if (hasData) {
          if (rel.type === 'hasMany') {
            // For hasMany, collect all related records in an array
            if (!grouped.relationships[rel.alias]) {
              grouped.relationships[rel.alias] = [];
            }
            
            // Check if this related record is already in the array (avoid duplicates)
            const relatedId = relatedData[rel.targetKey];
            const exists = grouped.relationships[rel.alias].some(
              (/** @type {any} */ item) => item[rel.targetKey] === relatedId
            );
            
            if (!exists) {
              grouped.relationships[rel.alias].push(relatedData);
            }
          } else {
            // For belongsTo and hasOne, just set the related object
            grouped.relationships[rel.alias] = relatedData;
          }
        }
      }
    }
  }
  
  // Convert grouped data back to array
  const result = [];
  for (const [, grouped] of groupedRows) {
    const mainObject = grouped.main;
    
    // Add relationship data to main object
    for (const rel of relationshipMap) {
      if (grouped.relationships[rel.alias]) {
        mainObject[rel.alias] = grouped.relationships[rel.alias];
      } else {
        // Set to null for belongsTo/hasOne, empty array for hasMany
        mainObject[rel.alias] = rel.type === 'hasMany' ? [] : null;
      }
    }
    
    result.push(mainObject);
  }
  
  return result;
}

/**
 * Map database column name to JavaScript property name
 * Handles snake_case to camelCase conversion
 * 
 * @param {string} columnName - Database column name
 * @returns {string} JavaScript property name
 */
function mapColumnToProperty(columnName) {
  // For now, keep the same naming (most fields use snake_case in both)
  // This can be extended for camelCase conversion if needed
  return columnName;
}

/**
 * Map JavaScript property name to database column name
 * Handles camelCase to snake_case conversion
 * 
 * @param {string} propertyName - JavaScript property name
 * @returns {string} Database column name
 */
function mapPropertyToColumn(propertyName) {
  // For now, keep the same naming (most fields use snake_case in both)
  // This can be extended for snake_case conversion if needed
  return propertyName;
}

/**
 * Validate field data type
 * 
 * @param {Object} field - Field metadata
 * @param {*} value - Value to validate
 * @returns {boolean} True if valid
 */
function validateFieldType(field, value) {
  if (value === null || value === undefined) {
    return field.nullable;
  }
  
  const actualType = typeof value;
  
  switch (field.type) {
    case 'string':
      return actualType === 'string';
    case 'number':
      return actualType === 'number' && !isNaN(value);
    case 'boolean':
      return actualType === 'boolean';
    case 'Date':
      return value instanceof Date || actualType === 'string';
    case 'Object':
    case 'Array':
      return actualType === 'object';
    default:
      return true;
  }
}

/**
 * Sanitize field value to prevent SQL injection
 * Handles type conversion and serialization
 * Uses the typeHandlers module for consistent type conversion
 * 
 * @param {*} value - Value to sanitize
 * @param {string|null} fieldType - Optional field type hint for better conversion
 * @returns {*} Sanitized value
 */
function sanitizeValue(value, fieldType = null) {
  // Use the centralized type handler for serialization
  return serializeValue(value, fieldType || undefined);
}

module.exports = {
  extractFields,
  buildInsertSQL,
  buildSelectSQL,
  buildUpdateSQL,
  buildDeleteSQL,
  buildWhereClause,
  buildJoinClause,
  mapJoinedResults,
  mapColumnToProperty,
  mapPropertyToColumn,
  validateFieldType,
  sanitizeValue,
  deserializeRow
};
