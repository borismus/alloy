import { useState, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import './FindInConversation.css';

interface FindInConversationProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

export interface FindInConversationHandle {
  focus: () => void;
}

// Utility function to highlight search terms using CSS Custom Highlight API
// Returns the array of ranges for navigation
function highlightSearchTerm(container: HTMLElement | null, search: string): Range[] {
  if (!CSS.highlights) {
    return [];
  }

  // Always clear previous highlights first
  CSS.highlights.clear();

  if (!container || !search.trim()) {
    return [];
  }

  const ranges: Range[] = [];
  const lowerSearch = search.toLowerCase();

  // Use TreeWalker to find all text nodes
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    const text = node.textContent?.toLowerCase() || '';
    let startIndex = 0;
    let index: number;

    while ((index = text.indexOf(lowerSearch, startIndex)) >= 0) {
      const range = new Range();
      range.setStart(node, index);
      range.setEnd(node, index + search.length);
      ranges.push(range);
      startIndex = index + search.length;
    }
  }

  if (ranges.length > 0) {
    const highlight = new Highlight(...ranges);
    CSS.highlights.set('search', highlight);
  }

  return ranges;
}

export const FindInConversation = forwardRef<FindInConversationHandle, FindInConversationProps>(
  function FindInConversation({ containerRef, onClose }, ref) {
  const [searchQuery, setSearchQuery] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }));

  // Auto-focus input when component mounts
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Update highlights when search query changes
  useEffect(() => {
    const ranges = highlightSearchTerm(containerRef.current, searchQuery);
    rangesRef.current = ranges;
    setMatchCount(ranges.length);
    setCurrentIndex(0);
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
    const rect = range.getBoundingClientRect();
    const container = containerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    // Check if the match is outside the visible area
    if (rect.top < containerRect.top || rect.bottom > containerRect.bottom) {
      // Scroll so the match is roughly centered
      const scrollTop = container.scrollTop + rect.top - containerRect.top - containerRect.height / 2;
      container.scrollTo({ top: scrollTop, behavior: 'smooth' });
    }
  };

  const goToNextMatch = () => {
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    const nextIndex = (currentIndex + 1) % ranges.length;
    setCurrentIndex(nextIndex);
    scrollToRange(ranges[nextIndex]);
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
    <div className="find-in-conversation">
      <input
        ref={inputRef}
        type="text"
        placeholder="Find in conversation..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        className="find-input"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      {searchQuery && (
        <span className="match-count">
          {matchCount > 0 ? `${currentIndex + 1} of ${matchCount}` : 'No matches'}
        </span>
      )}
      <button onClick={handleClose} className="find-close-button" title="Close (Esc)">
        ×
      </button>
    </div>
  );
});
