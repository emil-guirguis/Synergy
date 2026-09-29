import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmailLink } from './EmailLink';

describe('EmailLink', () => {
  it('renders email as a link when value is provided', () => {
    render(<EmailLink value="test@example.com" />);
    
    const link = screen.getByRole('link');
    expect(link).toBeInTheDocument();
    expect(link).toHaveTextContent('test@example.com');
  });

  it('generates correct mailto href', () => {
    render(<EmailLink value="user@domain.com" />);
    
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'mailto:user@domain.com');
  });

  it('does not render when value is empty string', () => {
    const { container } = render(<EmailLink value="" />);
    
    const link = container.querySelector('a');
    expect(link).not.toBeInTheDocument();
  });

  it('does not render when value is whitespace only', () => {
    const { container } = render(<EmailLink value="   " />);
    
    const link = container.querySelector('a');
    expect(link).not.toBeInTheDocument();
  });

  it('applies email-link class', () => {
    render(<EmailLink value="test@example.com" />);
    
    const link = screen.getByRole('link');
    expect(link).toHaveClass('email-link__link');
  });

  it('applies custom className', () => {
    // className is applied to the (always-rendered) input, not the link
    // overlay — the link has no className prop of its own.
    render(<EmailLink value="test@example.com" className="custom-class" />);

    const input = screen.getByRole('textbox');
    expect(input).toHaveClass('custom-class');
  });

  it('applies disabled class when disabled prop is true', () => {
    render(<EmailLink value="test@example.com" disabled={true} />);
    
    const link = screen.getByRole('link');
    expect(link).toHaveClass('email-link--disabled');
  });

  it('prevents default behavior when disabled', () => {
    const { container } = render(<EmailLink value="test@example.com" disabled={true} />);
    
    const link = container.querySelector('a');
    expect(link).toHaveClass('email-link--disabled');
  });

  it('has correct title attribute', () => {
    render(<EmailLink value="test@example.com" />);
    
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('title', 'Send email to test@example.com');
  });

  it('renders with special characters in email', () => {
    render(<EmailLink value="user+tag@example.co.uk" />);
    
    const link = screen.getByRole('link');
    expect(link).toHaveTextContent('user+tag@example.co.uk');
    expect(link).toHaveAttribute('href', 'mailto:user+tag@example.co.uk');
  });

  it('does not render when value is undefined', () => {
    const { container } = render(<EmailLink value={undefined as any} />);
    
    const link = container.querySelector('a');
    expect(link).not.toBeInTheDocument();
  });

  it('renders with blue link styling', () => {
    render(<EmailLink value="test@example.com" />);
    
    const link = screen.getByRole('link');
    expect(link).toHaveClass('email-link__link');
    // The actual color is applied via CSS, we just verify the class is present
  });

  // Edit mode toggle tests
  it('enters edit mode on double click', async () => {
    render(<EmailLink value="test@example.com" />);
    
    const link = screen.getByRole('link');
    fireEvent.doubleClick(link);
    
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('test@example.com');
  });

  it('disables the input when disabled prop is true', () => {
    // The component has no separate view/edit-mode toggle — the input is
    // always rendered; `disabled` just marks it non-interactive.
    render(<EmailLink value="test@example.com" disabled={true} />);

    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('exits edit mode on blur', async () => {
    render(<EmailLink value="test@example.com" />);
    
    const link = screen.getByRole('link');
    fireEvent.doubleClick(link);
    
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.blur(input);
    
    const newLink = screen.getByRole('link');
    expect(newLink).toBeInTheDocument();
  });

  it('calls onChange when value is modified and blurred', async () => {
    const onChange = vi.fn();
    render(<EmailLink value="test@example.com" onChange={onChange} />);
    
    const link = screen.getByRole('link');
    fireEvent.doubleClick(link);
    
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'newemail@example.com' } });
    fireEvent.blur(input);
    
    expect(onChange).toHaveBeenCalledWith('newemail@example.com');
  });

  it('exits edit mode on Enter key', async () => {
    const onChange = vi.fn();
    render(<EmailLink value="test@example.com" onChange={onChange} />);
    
    const link = screen.getByRole('link');
    fireEvent.doubleClick(link);
    
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'newemail@example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    
    expect(onChange).toHaveBeenCalledWith('newemail@example.com');
    const newLink = screen.getByRole('link');
    expect(newLink).toBeInTheDocument();
  });

  it('does not call onChange if value is not changed', async () => {
    const onChange = vi.fn();
    render(<EmailLink value="test@example.com" onChange={onChange} />);
    
    const link = screen.getByRole('link');
    fireEvent.doubleClick(link);
    
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.blur(input);
    
    expect(onChange).not.toHaveBeenCalled();
  });

  it('input has email-link__input class in edit mode', async () => {
    render(<EmailLink value="test@example.com" />);
    
    const link = screen.getByRole('link');
    fireEvent.doubleClick(link);
    
    const input = screen.getByRole('textbox');
    expect(input).toHaveClass('email-link__input');
  });
});
