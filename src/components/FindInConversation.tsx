import { useState, useRef, useEffect, useLayoutEffect, useImperativeHandle, forwardRef } from 'react';
import { useTextareaProps } from '../utils/textareaProps';
import { findMatchRanges, nextMatchIndex, prevMatchIndex } from '../utils/findMatches';
import './FindInConversation.css';

interface FindInConversationProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

export interface FindInConversationHandle {
  focus: () => void;
  next: () => void;
  previous: () => void;
}

// Find matches and paint them via the CSS Custom Highlight API.
// Returns the array of ranges for navigation. Match-finding lives in
// findMatchRanges so it stays testable independent of the highlight API.
function highlightSearchTerm(container: HTMLElement | null, search: string): Range[] {
  const ranges = findMatchRanges(container, search);

  if (CSS.highlights) {
    // Always clear previous highlights first
    CSS.highlights.clear();
    if (ranges.length > 0) {
      CSS.highlights.set('search', new Highlight(...ranges));
    }
  }

  return ranges;
}

// Paint the active match in a distinct color by registering it as a separate,
// higher-priority highlight that overlaps the general 'search' highlight.
function setCurrentHighlight(range: Range | undefined) {
  if (!CSS.highlights) return;
  if (!range) {
    CSS.highlights.delete('search-current');
    return;
  }
  const highlight = new Highlight(range);
  highlight.priority = 1;
  CSS.highlights.set('search-current', highlight);
}

export const FindInConversation = forwardRef<FindInConversationHandle, FindInConversationProps>(
  function FindInConversation({ containerRef, onClose }, ref) {
  const textareaProps = useTextareaProps();
  const [searchQuery, setSearchQuery] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [topOffset, setTopOffset] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
    next: () => goToNextMatch(),
    previous: () => goToPreviousMatch(),
  }));

  // Auto-focus input when component mounts
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Position the bar just below the view's header (if any), so it doesn't
  // overlap it. The header lives inside the conversation/note component, so
  // we measure it rather than hardcode a height that varies per view.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const header = container?.querySelector('.item-header');
    if (container && header) {
      setTopOffset(header.getBoundingClientRect().bottom - container.getBoundingClientRect().top);
    } else {
      setTopOffset(0);
    }
  }, [containerRef]);

  // Update highlights when search query changes
  useEffect(() => {
    const ranges = highlightSearchTerm(containerRef.current, searchQuery);
    rangesRef.current = ranges;
    setMatchCount(ranges.length);
    setCurrentIndex(0);
    setCurrentHighlight(ranges[0]);
    // Scroll to first match if there is one
    if (ranges.length > 0) {
      scrollToRange(ranges[0]);
    }
  }, [searchQuery, containerRef]);

  // Cleanup highlights when component unmounts
  useEffect(() => {
    return () => {
      CSS.highlights?.clear();
    };
  }, []);

  const scrollToRange = (range: Range) => {
    const element = range.startContainer.parentElement;
    if (element) {
      element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };

  const goToNextMatch = () => {
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    const nextIndex = nextMatchIndex(currentIndex, ranges.length);
    setCurrentIndex(nextIndex);
    setCurrentHighlight(ranges[nextIndex]);
    scrollToRange(ranges[nextIndex]);
  };

  const goToPreviousMatch = () => {
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    const prevIndex = prevMatchIndex(currentIndex, ranges.length);
    setCurrentIndex(prevIndex);
    setCurrentHighlight(ranges[prevIndex]);
    scrollToRange(ranges[prevIndex]);
  };

  const handleClose = () => {
    setSearchQuery('');
    highlightSearchTerm(containerRef.current, '');
    inputRef.current?.blur();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      goToNextMatch();
    }
  };

  return (
    <div className="find-in-conversation" style={{ top: topOffset }}>
      <input
        ref={inputRef}
        type="text"
        placeholder="Find in conversation..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        className="find-input"
        {...textareaProps}
      />
      {searchQuery && (
        <span className="match-count">
          {matchCount > 0 ? `${currentIndex + 1} of ${matchCount}` : 'No matches'}
        </span>
      )}
      <button
        onClick={goToPreviousMatch}
        className="find-nav-button"
        title="Previous match"
        disabled={matchCount === 0}
      >
        ▲
      </button>
      <button
        onClick={goToNextMatch}
        className="find-nav-button"
        title="Next match"
        disabled={matchCount === 0}
      >
        ▼
      </button>
      <button onClick={handleClose} className="find-close-button" title="Close (Esc)">
        ×
      </button>
    </div>
  );
});
