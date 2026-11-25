import type { QuestionAnswer } from '../shared/questions';
import './question-answers.css';

export default function QuestionAnswers({ pairs }: { pairs: QuestionAnswer[] }) {
  return <dl className="question-answers">{pairs.map(({ question, answer }, index) =>
    <div key={index}><dt>{question}</dt><dd>{answer}</dd></div>
  )}</dl>;
}
