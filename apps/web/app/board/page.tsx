"use client";

import { useState } from "react";
import { BoardView } from "@/components/BoardView";
import { AdvisorView } from "@/components/AdvisorView";
import { WorkPreviewPanel } from "@/components/WorkPreviewPanel";

export default function BoardPage() {
  // No selection → Advisor chat; a selected Work card → its preview (design: Home / Home Task Detail).
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [boardRefreshToken, setBoardRefreshToken] = useState(0);

  const handleWorkDeleted = () => {
    setSelectedCardId(null);
    setBoardRefreshToken((current) => current + 1);
  };

  return (
    <div className="board-layout">
      <div className="board-layout__left">
        {selectedCardId ? (
          <WorkPreviewPanel
            key={selectedCardId}
            workId={selectedCardId}
            onBack={() => setSelectedCardId(null)}
            onDeleted={handleWorkDeleted}
          />
        ) : (
          <AdvisorView />
        )}
      </div>
      <div className="board-layout__right">
        <BoardView
          onSelectCard={setSelectedCardId}
          selectedCardId={selectedCardId}
          refreshToken={boardRefreshToken}
        />
      </div>
    </div>
  );
}
