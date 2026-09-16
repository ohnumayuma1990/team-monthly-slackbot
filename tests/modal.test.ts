/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  buildSubmissionModal,
  generateMonthOptions,
  SUBMISSION_MODAL_CALLBACK_ID,
} from '../src/slack/modals/submissionModal';

describe('Slack Submission Modal Builder', () => {
  it('generates 3 month options (previous, current, next)', () => {
    const options = generateMonthOptions();
    expect(options.length).toBe(3);
    expect(options[1].text.text).toContain('(当月)');
  });

  it('builds modal view with correct callback_id and initial member name', () => {
    const modal = buildSubmissionModal('大沼 佑磨');
    expect(modal.type).toBe('modal');
    expect(modal.callback_id).toBe(SUBMISSION_MODAL_CALLBACK_ID);

    // Find the member name block
    const nameBlock = modal.blocks.find(
      (b: any) => b.block_id === 'member_name_block'
    ) as any;
    expect(nameBlock).toBeDefined();
    expect(nameBlock.element.initial_value).toBe('大沼 佑磨');

    // Verify submission type block
    const typeBlock = modal.blocks.find(
      (b: any) => b.block_id === 'submission_type_block'
    ) as any;
    expect(typeBlock).toBeDefined();
    expect(typeBlock.element.options.length).toBe(3);
  });
});
