
export default function QuizEditor({ value, onChange, error, disabled }) {
  function optionChange(key, patch) { onChange({ ...value, options: value.options.map((o) => o.key === key ? { ...o, ...patch } : o) }) }
  return <section className="av-quiz" aria-labelledby="quiz-title">
    <header className="av-quiz-header"><div><h2 id="quiz-title">참여형 퀴즈 <span>선택사항</span></h2><p>영상과 함께 풀어볼 객관식 퀴즈를 추가하세요.</p></div><label className="av-switch"><input type="checkbox" role="switch" checked={value.enabled} disabled={disabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} /><span className="av-switch-track" />퀴즈 포함</label></header>
    {value.enabled && <div className="av-quiz-fields">
      <label htmlFor="quiz-question">질문 <em>*</em></label><textarea id="quiz-question" maxLength={200} value={value.question} disabled={disabled} onChange={(e) => onChange({ ...value, question: e.target.value })} placeholder="영상 내용을 바탕으로 질문을 입력하세요." />
      <fieldset><legend>보기 <em>*</em> <span>왼쪽 동그라미로 정답 하나를 선택하세요.</span></legend>
        {value.options.map((option, i) => <div className={`av-quiz-option ${option.isCorrect ? 'is-answer' : ''}`} key={option.key}>
          <input type="radio" name="quiz-correct" aria-label={`보기 ${i + 1} 정답으로 설정`} checked={option.isCorrect} disabled={disabled} onChange={() => onChange({ ...value, options: value.options.map((o) => ({ ...o, isCorrect: o.key === option.key })) })} />
          <span>{i + 1}</span><input type="text" aria-label={`보기 ${i + 1}`} placeholder={`보기 ${i + 1}의 내용`} maxLength={100} value={option.content} disabled={disabled} onChange={(e) => optionChange(option.key, { content: e.target.value })} />
          <button type="button" aria-label={`보기 ${i + 1} 삭제`} disabled={disabled || value.options.length <= 2} onClick={() => onChange({ ...value, options: value.options.filter((o) => o.key !== option.key) })}>×</button>
        </div>)}
      </fieldset>
      <div className="av-quiz-tools"><span>{value.options.length}/5개 · 최소 2개</span><button className="av-button" type="button" disabled={disabled || value.options.length >= 5} onClick={() => onChange({ ...value, options: [...value.options, { key: crypto.randomUUID(), content: '', isCorrect: false }] })}>＋ 보기 추가</button></div>
    </div>}
    {error && <p className="av-error" role="alert">{error}</p>}
  </section>
}
