import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { ApprovalRequest } from '../services/tools/executor';
import { WriteApprovalModal } from '../components/WriteApprovalModal';

interface ApprovalContextValue {
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
}

const ApprovalContext = createContext<ApprovalContextValue | null>(null);

export function useApproval() {
  const context = useContext(ApprovalContext);
  if (!context) {
    throw new Error('useApproval must be used within an ApprovalProvider');
  }
  return context;
}

interface ApprovalProviderProps {
  children: ReactNode;
}

export function ApprovalProvider({ children }: ApprovalProviderProps) {
  const [pendingApproval, setPendingApproval] = useState<{
    request: ApprovalRequest;
    resolve: (approved: boolean) => void;
  } | null>(null);

  const requestApproval = useCallback((request: ApprovalRequest): Promise<boolean> => {
    return new Promise((resolve) => {
      setPendingApproval({ request, resolve });
    });
  }, []);

  const handleApprove = useCallback(() => {
    if (pendingApproval) {
      pendingApproval.resolve(true);
      setPendingApproval(null);
    }
  }, [pendingApproval]);

  const handleReject = useCallback(() => {
    if (pendingApproval) {
      pendingApproval.resolve(false);
      setPendingApproval(null);
    }
  }, [pendingApproval]);

  return (
    <ApprovalContext.Provider value={{ requestApproval }}>
      {children}
      {pendingApproval && (
        <WriteApprovalModal
          request={pendingApproval.request}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}
    </ApprovalContext.Provider>
  );
}
