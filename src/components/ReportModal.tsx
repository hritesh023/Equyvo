import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle } from 'lucide-react';
import { showSuccess, showError } from '@/utils/toast';
import api from '@/lib/api';
import { evalReport } from '@/lib/human-eval';

interface ReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  contentId: string;
  contentType: 'post' | 'video' | 'thought' | 'moment' | 'comment' | 'story';
}

const ReportModal: React.FC<ReportModalProps> = ({
  isOpen,
  onClose,
  contentId,
  contentType
}) => {
  const [reasons, setReasons] = useState<string[]>([]);
  const [additionalInfo, setAdditionalInfo] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const reportReasons = [
    { value: 'spam', label: 'Spam or misleading content' },
    { value: 'inappropriate', label: 'Inappropriate / sexual content' },
    { value: 'harassment', label: 'Harassment or bullying' },
    { value: 'hate', label: 'Hate speech' },
    { value: 'violence', label: 'Violent or dangerous content' },
    { value: 'self-harm', label: 'Self-harm or suicide' },
    { value: 'copyright', label: 'Copyright infringement' },
    { value: 'privacy', label: 'Privacy violation' },
    { value: 'scam', label: 'Scam or fraud' },
    { value: 'other', label: 'Other' },
  ];

  const toggleReason = (value: string, checked: boolean) => {
    setReasons((prev) => (checked ? [...prev, value] : prev.filter((r) => r !== value)));
  };

  const handleSubmit = async () => {
    if (!reasons.length) {
      showError('Please tick at least one reason for reporting');
      return;
    }

    setIsSubmitting(true);

    try {
      const kind = contentType === 'video' ? 'post' : contentType === 'comment' ? 'post' : contentType === 'story' ? 'story' : contentType;
      const { error } = await api.reportContent({
        kind,
        id: contentId,
        reason: reasons[0],
        reasons,
        details: additionalInfo,
      });
      if (error) throw new Error(error);
      // Human eval: reports are strong negative labels for the shared brain
      // (fire-and-forget — never blocks the safety flow).
      try { evalReport(contentId, reasons.join(',')); } catch { /* ignore */ }
      showSuccess('Report submitted. Our team will review it in the Acronous dashboard.');
      handleClose();
    } catch {
      showError('Failed to submit report. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setReasons([]);
    setAdditionalInfo('');
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-orange-500" />
            Report Content
          </DialogTitle>
          <DialogDescription>
            Tick all reasons that apply. Reports go straight to the Acronous safety queue for review.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Why are you reporting this? (tick all that apply)</Label>
            <div className="grid gap-2">
              {reportReasons.map((reason) => (
                <label key={reason.value} className="flex cursor-pointer items-center space-x-2.5 rounded-lg border border-border/50 px-3 py-2 hover:bg-secondary/30">
                  <Checkbox
                    checked={reasons.includes(reason.value)}
                    onCheckedChange={(c) => toggleReason(reason.value, c === true)}
                    aria-label={reason.label}
                  />
                  <span className="text-sm">{reason.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="additional-info" className="text-sm font-medium">
              Additional information (optional)
            </Label>
            <Textarea
              id="additional-info"
              placeholder="Add any extra context that helps review — e.g. timestamps, what exactly is wrong…"
              value={additionalInfo}
              onChange={(e) => setAdditionalInfo(e.target.value)}
              rows={3}
              className="resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!reasons.length || isSubmitting}
            className="bg-red-600 hover:bg-red-700"
          >
            {isSubmitting ? 'Submitting…' : `Submit Report${reasons.length > 1 ? ` (${reasons.length})` : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ReportModal;
