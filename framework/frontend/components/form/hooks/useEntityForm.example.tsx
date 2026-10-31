/**
 * Example usage of useEntityForm hook
 * 
 * This file demonstrates how to use the useEntityForm hook to simplify
 * form initialization and management for entity forms.
 */

import React from 'react';
import { useEntityForm } from './useEntityForm';

// ============================================================================
// Example 1: Simple Contact Form
// ============================================================================

interface Contact {
  id: string;
  name: string;
  email: string;
  phone: string;
}

interface ContactFormData {
  name: string;
  email: string;
  phone: string;
}

interface ContactFormProps {
  contact?: Contact;
  onSubmit: (data: ContactFormData) => Promise<void>;
  onCancel: () => void;
}

export const SimpleContactForm: React.FC<ContactFormProps> = ({
  contact,
  onSubmit,
  onCancel,
}) => {
  const { formData, isEditMode, updateField } = useEntityForm<Contact, ContactFormData>({
    entity: contact,
    entityToFormData: (contact) => ({
      name: contact.name || '',
      email: contact.email || '',
      phone: contact.phone || '',
    }),
    getDefaultFormData: () => ({
      name: '',
      email: '',
      phone: '',
    }),
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit}>
      <h2>{isEditMode ? 'Edit Contact' : 'Create Contact'}</h2>
      
      <div>
        <label htmlFor="name">Name</label>
        <input
          id="name"
          type="text"
          value={formData.name}
          onChange={(e) => updateField('name', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={formData.email}
          onChange={(e) => updateField('email', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="phone">Phone</label>
        <input
          id="phone"
          type="tel"
          value={formData.phone}
          onChange={(e) => updateField('phone', e.target.value)}
        />
      </div>
      
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="submit">{isEditMode ? 'Update' : 'Create'}</button>
    </form>
  );
};

// ============================================================================
// Example 2: Form with Nested Data (Address)
// ============================================================================

interface User {
  id: string;
  name: string;
  email: string;
  address: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
  };
}

interface UserFormData {
  name: string;
  email: string;
  address: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
  };
}

interface UserFormProps {
  user?: User;
  onSubmit: (data: UserFormData) => Promise<void>;
  onCancel: () => void;
}

export const UserFormWithNestedData: React.FC<UserFormProps> = ({
  user,
  onSubmit,
  onCancel,
}) => {
  const { formData, isEditMode, updateField } = useEntityForm<User, UserFormData>({
    entity: user,
    entityToFormData: (user) => ({
      name: user.name || '',
      email: user.email || '',
      address: {
        street: user.address?.street || '',
        city: user.address?.city || '',
        state: user.address?.state || '',
        zipCode: user.address?.zipCode || '',
      },
    }),
    getDefaultFormData: () => ({
      name: '',
      email: '',
      address: {
        street: '',
        city: '',
        state: '',
        zipCode: '',
      },
    }),
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit}>
      <h2>{isEditMode ? 'Edit User' : 'Create User'}</h2>
      
      <div>
        <label htmlFor="name">Name</label>
        <input
          id="name"
          type="text"
          value={formData.name}
          onChange={(e) => updateField('name', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={formData.email}
          onChange={(e) => updateField('email', e.target.value)}
        />
      </div>
      
      <h3>Address</h3>
      
      {/* Using dot notation for nested fields */}
      <div>
        <label htmlFor="street">Street</label>
        <input
          id="street"
          type="text"
          value={formData.address.street}
          onChange={(e) => updateField('address.street', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="city">City</label>
        <input
          id="city"
          type="text"
          value={formData.address.city}
          onChange={(e) => updateField('address.city', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="state">State</label>
        <input
          id="state"
          type="text"
          value={formData.address.state}
          onChange={(e) => updateField('address.state', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="zipCode">ZIP Code</label>
        <input
          id="zipCode"
          type="text"
          value={formData.address.zipCode}
          onChange={(e) => updateField('address.zipCode', e.target.value)}
        />
      </div>
      
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="submit">{isEditMode ? 'Update' : 'Create'}</button>
    </form>
  );
};

// ============================================================================
// Example 3: Form with Initialization Callback
// ============================================================================

interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
}

interface ProductFormData {
  name: string;
  price: string; // String for input handling
  category: string;
}

interface ProductFormProps {
  product?: Product;
  onSubmit: (data: ProductFormData) => Promise<void>;
  onCancel: () => void;
}

export const ProductFormWithCallback: React.FC<ProductFormProps> = ({
  product,
  onSubmit,
  onCancel,
}) => {
  const { formData, isEditMode, updateField, resetForm } = useEntityForm<Product, ProductFormData>({
    entity: product,
    entityToFormData: (product) => ({
      name: product.name || '',
      price: product.price?.toString() || '',
      category: product.category || '',
    }),
    getDefaultFormData: () => ({
      name: '',
      price: '',
      category: '',
    }),
    onInitialize: (formData, mode) => {
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSubmit(formData);
  };

  const handleReset = () => {
    resetForm();
  };

  return (
    <form onSubmit={handleSubmit}>
      <h2>{isEditMode ? 'Edit Product' : 'Create Product'}</h2>
      
      <div>
        <label htmlFor="name">Product Name</label>
        <input
          id="name"
          type="text"
          value={formData.name}
          onChange={(e) => updateField('name', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="price">Price</label>
        <input
          id="price"
          type="number"
          step="0.01"
          value={formData.price}
          onChange={(e) => updateField('price', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="category">Category</label>
        <select
          id="category"
          value={formData.category}
          onChange={(e) => updateField('category', e.target.value)}
        >
          <option value="">Select a category</option>
          <option value="electronics">Electronics</option>
          <option value="clothing">Clothing</option>
          <option value="food">Food</option>
        </select>
      </div>
      
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="button" onClick={handleReset}>Reset</button>
      <button type="submit">{isEditMode ? 'Update' : 'Create'}</button>
    </form>
  );
};

// ============================================================================
// Example 4: Using with setFormData for Complex Updates
// ============================================================================

interface Location {
  id: string;
  name: string;
  coordinates: {
    lat: number;
    lng: number;
  };
  tags: string[];
}

interface LocationFormData {
  name: string;
  coordinates: {
    lat: string;
    lng: string;
  };
  tags: string[];
  tagInput: string;
}

interface LocationFormProps {
  location?: Location;
  onSubmit: (data: Omit<LocationFormData, 'tagInput'>) => Promise<void>;
  onCancel: () => void;
}

export const LocationFormWithComplexState: React.FC<LocationFormProps> = ({
  location,
  onSubmit,
  onCancel,
}) => {
  const { formData, setFormData, isEditMode, updateField } = useEntityForm<Location, LocationFormData>({
    entity: location,
    entityToFormData: (location) => ({
      name: location.name || '',
      coordinates: {
        lat: location.coordinates?.lat?.toString() || '',
        lng: location.coordinates?.lng?.toString() || '',
      },
      tags: location.tags || [],
      tagInput: '',
    }),
    getDefaultFormData: () => ({
      name: '',
      coordinates: {
        lat: '',
        lng: '',
      },
      tags: [],
      tagInput: '',
    }),
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { tagInput, ...submitData } = formData;
    await onSubmit(submitData);
  };

  const addTag = () => {
    const tag = formData.tagInput.trim();
    if (tag && !formData.tags.includes(tag)) {
      setFormData(prev => ({
        ...prev,
        tags: [...prev.tags, tag],
        tagInput: '',
      }));
    }
  };

  const removeTag = (index: number) => {
    setFormData(prev => ({
      ...prev,
      tags: prev.tags.filter((_, i) => i !== index),
    }));
  };

  return (
    <form onSubmit={handleSubmit}>
      <h2>{isEditMode ? 'Edit Location' : 'Create Location'}</h2>
      
      <div>
        <label htmlFor="name">Location Name</label>
        <input
          id="name"
          type="text"
          value={formData.name}
          onChange={(e) => updateField('name', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="lat">Latitude</label>
        <input
          id="lat"
          type="number"
          step="any"
          value={formData.coordinates.lat}
          onChange={(e) => updateField('coordinates.lat', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="lng">Longitude</label>
        <input
          id="lng"
          type="number"
          step="any"
          value={formData.coordinates.lng}
          onChange={(e) => updateField('coordinates.lng', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="tags">Tags</label>
        <div>
          {formData.tags.map((tag, index) => (
            <span key={index}>
              {tag}
              <button type="button" onClick={() => removeTag(index)}>×</button>
            </span>
          ))}
        </div>
        <input
          id="tags"
          type="text"
          value={formData.tagInput}
          onChange={(e) => updateField('tagInput', e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addTag();
            }
          }}
        />
        <button type="button" onClick={addTag}>Add Tag</button>
      </div>
      
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="submit">{isEditMode ? 'Update' : 'Create'}</button>
    </form>
  );
};

// ============================================================================
// Example 5: Form with Field Validation (Development Mode)
// ============================================================================

/**
 * This example demonstrates automatic field validation that helps catch
 * mismatches between form fields and backend entity structure during development.
 * 
 * The validation will log warnings to the console if:
 * - Form has fields that don't exist in the entity
 * - Entity has fields that aren't in the form (verbose mode only)
 */

interface BackendContact {
  id: string;
  name: string;
  email: string;
  phone: string;
  // Backend has these fields
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  active: boolean;
  notes: string;
}

interface ContactFormDataWithValidation {
  name: string;
  email: string;
  phone: string;
  // Oops! Using 'address' object instead of flat fields
  address: {
    street: string;
    city: string;
  };
  // This field doesn't exist in backend
  website: string;
}

interface ValidatedContactFormProps {
  contact?: BackendContact;
  onSubmit: (data: ContactFormDataWithValidation) => Promise<void>;
  onCancel: () => void;
}

export const ValidatedContactForm: React.FC<ValidatedContactFormProps> = ({
  contact,
  onSubmit,
  onCancel,
}) => {
  // The hook will automatically validate fields and log warnings in development
  const { formData, isEditMode, updateField } = useEntityForm<BackendContact, ContactFormDataWithValidation>({
    entity: contact,
    entityName: 'Contact', // Used in validation messages
    validateFields: true, // Enable validation (default: true)
    entityToFormData: (contact) => ({
      name: contact.name || '',
      email: contact.email || '',
      phone: contact.phone || '',
      address: {
        street: contact.street || '',
        city: contact.city || '',
      },
      website: '', // This field doesn't exist in backend!
    }),
    getDefaultFormData: () => ({
      name: '',
      email: '',
      phone: '',
      address: {
        street: '',
        city: '',
      },
      website: '',
    }),
  });

  // In development, you'll see console warnings like:
  // [Field Validation] Contact form has fields that don't exist in backend entity:
  // ['address', 'website']
  // These fields will not be populated when editing. Check your backend model or remove these fields from the form.

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit}>
      <h2>{isEditMode ? 'Edit Contact' : 'Create Contact'}</h2>
      
      <div>
        <label htmlFor="name">Name</label>
        <input
          id="name"
          type="text"
          value={formData.name}
          onChange={(e) => updateField('name', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={formData.email}
          onChange={(e) => updateField('email', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="phone">Phone</label>
        <input
          id="phone"
          type="tel"
          value={formData.phone}
          onChange={(e) => updateField('phone', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="street">Street</label>
        <input
          id="street"
          type="text"
          value={formData.address.street}
          onChange={(e) => updateField('address.street', e.target.value)}
        />
      </div>
      
      <div>
        <label htmlFor="website">Website</label>
        <input
          id="website"
          type="url"
          value={formData.website}
          onChange={(e) => updateField('website', e.target.value)}
        />
      </div>
      
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="submit">{isEditMode ? 'Update' : 'Create'}</button>
    </form>
  );
};
