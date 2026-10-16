import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DebugOverlay } from './DebugOverlay';
import { getDebugOverlay, setDebugOverlay } from '../services/debugOverlay';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('DebugOverlay', () => {
  it('renders nothing while the switch is off', () => {
    render(<DebugOverlay />);
    expect(screen.queryByTestId('debug-overlay')).toBeNull();
  });

  it('appears as soon as the switch is flipped, and remembers it on this device', () => {
    render(<DebugOverlay />);
    act(() => setDebugOverlay(true));
    expect(screen.getByTestId('debug-overlay').textContent).toContain('innerH');
    expect(getDebugOverlay()).toBe(true);

    act(() => setDebugOverlay(false));
    expect(screen.queryByTestId('debug-overlay')).toBeNull();
    expect(getDebugOverlay()).toBe(false);
  });

  it('reports where a tap registered and what it hit', () => {
    setDebugOverlay(true);
    render(
      <>
        <button type="button" className="composer-send">Send</button>
        <DebugOverlay />
      </>,
    );
    fireEvent.pointerDown(screen.getByText('Send'), { clientX: 30, clientY: 412 });
    expect(screen.getByTestId('debug-overlay').textContent).toContain('y=412 -> button.composer-send');
  });
});
