// THE GOOGLE BUTTON. Small, and every part of it is a thing that breaks
// sign-in when it drifts: the href must point at the handler that actually
// exists, the mark must be Google's four colours (their brand rules, and a
// grey G reads as broken), and the label must say what Google requires it
// to say.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GoogleSignInButton, GOOGLE_START_PATH } from '@/components/google-signin';

const html = renderToStaticMarkup(<GoogleSignInButton />);

describe('GoogleSignInButton', () => {
  it('points at the start handler that exists on this app', () => {
    // app/api/auth/google/start/route.ts — if that moves, this fails here
    // rather than as a 404 in front of someone trying to sign in.
    expect(GOOGLE_START_PATH).toBe('/api/auth/google/start');
    expect(html).toContain(`href="${GOOGLE_START_PATH}"`);
  });

  it('says one of the phrases Google permits, and says it in full', () => {
    expect(html).toContain('Continue with Google');
  });

  it('draws the four-colour G — all four, inline, no third-party image', () => {
    for (const colour of ['#4285F4', '#34A853', '#FBBC05', '#EA4335']) {
      expect(html).toContain(colour);
    }
    expect(html).not.toContain('<img');
    expect(html).not.toContain('gstatic');
  });

  it('is a real link, so middle-click and screen readers behave', () => {
    expect(html.startsWith('<div')).toBe(true);
    expect(html).toContain('<a ');
    expect(html).not.toContain('<button');
  });

  it('separates itself from the email form with an OR the reader can see', () => {
    expect(html).toContain('or');
  });
});
