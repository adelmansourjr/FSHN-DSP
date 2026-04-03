import { addDoc, collection, deleteDoc, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from './firebase';

type ReportTargetType = 'post' | 'user' | 'listing';

type CreateReportInput = {
  reporterUid: string;
  targetType: ReportTargetType;
  targetId: string;
  reasonCode?: string;
  note?: string;
};

type ReportPostInput = {
  reporterUid: string;
  postId: string;
  reasonCode?: string;
  note?: string;
};

type ReportUserInput = {
  reporterUid: string;
  targetUid: string;
  reasonCode?: string;
  note?: string;
};

type ReportCommentInput = {
  reporterUid: string;
  postId: string;
  commentId: string;
  reasonCode?: string;
  note?: string;
};

type ReportReplyInput = {
  reporterUid: string;
  postId: string;
  commentId: string;
  replyId: string;
  reasonCode?: string;
  note?: string;
};

type BlockUserInput = {
  viewerUid: string;
  targetUid: string;
  reason?: string;
};

type UnblockUserInput = {
  viewerUid: string;
  targetUid: string;
};

const normalizeReason = (value?: string) => String(value || '').trim().slice(0, 80) || 'inappropriate';
const normalizeNote = (value?: string) => String(value || '').trim().slice(0, 500);

export class ReportRecord {
  reporterUid: string;
  targetType: ReportTargetType;
  targetId: string;
  reasonCode: string;
  note: string;
  status: 'open';
  resolvedAt: null;
  resolvedByUid: null;

  constructor(input: CreateReportInput) {
    this.reporterUid = input.reporterUid;
    this.targetType = input.targetType;
    this.targetId = input.targetId;
    this.reasonCode = normalizeReason(input.reasonCode);
    this.note = normalizeNote(input.note);
    this.status = 'open';
    this.resolvedAt = null;
    this.resolvedByUid = null;
  }

  toFirestore() {
    return {
      reporterUid: this.reporterUid,
      targetType: this.targetType,
      targetId: this.targetId,
      reasonCode: this.reasonCode,
      note: this.note,
      createdAt: serverTimestamp(),
      status: this.status,
      resolvedAt: this.resolvedAt,
      resolvedByUid: this.resolvedByUid,
    };
  }
}

export class BlockRecord {
  reason: string;

  constructor(reason?: string) {
    this.reason = String(reason || '').slice(0, 120);
  }

  toFirestore() {
    return {
      createdAt: serverTimestamp(),
      reason: this.reason,
    };
  }
}

export class ReportService {
  async createReport(input: CreateReportInput) {
    const report = new ReportRecord(input);
    await addDoc(collection(db, 'reports'), report.toFirestore());
  }

  async reportPost(input: ReportPostInput) {
    await this.createReport({
      reporterUid: input.reporterUid,
      targetType: 'post',
      targetId: input.postId,
      reasonCode: input.reasonCode,
      note: input.note,
    });
  }

  async reportUser(input: ReportUserInput) {
    await this.createReport({
      reporterUid: input.reporterUid,
      targetType: 'user',
      targetId: input.targetUid,
      reasonCode: input.reasonCode || 'harassment',
      note: input.note,
    });
  }

  async reportComment(input: ReportCommentInput) {
    const contextNote = [`commentId=${input.commentId}`, input.note || ''].filter(Boolean).join(' | ');
    await this.createReport({
      reporterUid: input.reporterUid,
      targetType: 'post',
      targetId: input.postId,
      reasonCode: input.reasonCode || 'abusive_comment',
      note: contextNote,
    });
  }

  async reportReply(input: ReportReplyInput) {
    const contextNote = [
      `commentId=${input.commentId}`,
      `replyId=${input.replyId}`,
      input.note || '',
    ]
      .filter(Boolean)
      .join(' | ');
    await this.createReport({
      reporterUid: input.reporterUid,
      targetType: 'post',
      targetId: input.postId,
      reasonCode: input.reasonCode || 'abusive_reply',
      note: contextNote,
    });
  }
}

export class BlockService {
  async blockUser(input: BlockUserInput) {
    const block = new BlockRecord(input.reason);
    await setDoc(doc(db, 'users', input.viewerUid, 'blocked', input.targetUid), block.toFirestore());
  }

  async unblockUser(input: UnblockUserInput) {
    await deleteDoc(doc(db, 'users', input.viewerUid, 'blocked', input.targetUid));
  }
}

export const reportService = new ReportService();
export const blockService = new BlockService();

export async function reportPost(input: ReportPostInput) {
  return reportService.reportPost(input);
}

export async function reportUser(input: ReportUserInput) {
  return reportService.reportUser(input);
}

export async function reportComment(input: ReportCommentInput) {
  return reportService.reportComment(input);
}

export async function reportReply(input: ReportReplyInput) {
  return reportService.reportReply(input);
}

export async function blockUser(input: BlockUserInput) {
  return blockService.blockUser(input);
}

export async function unblockUser(input: UnblockUserInput) {
  return blockService.unblockUser(input);
}
