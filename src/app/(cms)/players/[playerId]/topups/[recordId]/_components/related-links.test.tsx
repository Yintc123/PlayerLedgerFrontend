// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { RelatedLinks } from './related-links';

describe('RelatedLinks', () => {
  it('should render link to /players/[playerId]', () => {
    render(<RelatedLinks playerId="01HABC" />);
    expect(screen.getByRole('link', { name: '玩家詳情' })).toHaveAttribute(
      'href',
      '/players/01HABC'
    );
  });

  it('should render link to /players/[playerId]/topups', () => {
    render(<RelatedLinks playerId="01HABC" />);
    expect(screen.getByRole('link', { name: '玩家儲值列表' })).toHaveAttribute(
      'href',
      '/players/01HABC/topups'
    );
  });

  it('should expose role="navigation" with aria-label="related links"', () => {
    render(<RelatedLinks playerId="01HABC" />);
    expect(screen.getByRole('navigation', { name: 'related links' })).toBeInTheDocument();
  });
});
