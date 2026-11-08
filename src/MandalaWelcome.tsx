import { useLanguage } from './i18n';
import Button from './ui/Button';
import BrandMark from './ui/BrandMark';
import Icon from './ui/Icon';

export default function MandalaWelcome({name,disabled,hasDraft,onPrepare}:{name:string;disabled:boolean;hasDraft:boolean;onPrepare:(text:string)=>void}) {
  const {text:l}=useLanguage();
  const suggestions=[
    {
      title:l('梳理现有工作','Explore existing work'),
      description:l('从已有工作线索，建议项目和 Agent 的划分。','Use existing work to suggest Projects and Agents.'),
      prompt:l('请帮我梳理现有工作：先查看可用的工作线索，按业务整理 Project 和工作路径，再按相对独立、知识可复用的模块建议 Agent。先给我规划草案，等我确认后再创建。','Help me organize my existing work. Review available work evidence, group Projects and working paths by business, then suggest Agents for relatively independent modules with reusable knowledge. Present a draft plan and wait for my confirmation before creating anything.'),
    },
    {
      title:l('介绍我的业务','Describe my business'),
      description:l('从你的描述开始，整理业务路径与知识模块。','Start with your description of the business and its modules.'),
      prompt:l('我想先介绍自己的业务，请根据我的描述一起规划。先问我主要负责哪些业务、使用哪些仓库或工作路径，再一起识别值得长期积累知识的模块。先给出 Project 和 Agent 草案，等我确认后再创建。','I want to describe my business and plan together. First ask about the business areas I work on and their repositories or working paths, then help identify modules that benefit from long-term knowledge. Draft Projects and Agents and wait for my confirmation before creating them.'),
    },
    {
      title:l('先推进一件事','Start with one task'),
      description:l('直接说目标，不必先完成全部配置。','Share a goal; you can organize the rest as you go.'),
      prompt:l('我想先推进一件具体的事。请先问我想达成的结果、相关工作路径和完成标准，再根据现有配置建议下一步。','I want to work on one concrete task. First ask about the outcome, relevant working paths and completion criteria, then suggest the next step based on the current setup.'),
    },
  ];
  return <section className="mandala-welcome" aria-label={l('Mandala 开始指引','Get started with Mandala')}>
    <BrandMark/><h1>{name}</h1>
    <p className="mandala-welcome-intro">{l('从一件事开始，也可以先梳理你的业务。','Start with a task, or organize your business first.')}</p>
    <div className="mandala-welcome-suggestions">
      {suggestions.map(item=><Button key={item.title} type="button" disabled={disabled||hasDraft} onClick={()=>onPrepare(item.prompt)}>
        <span><strong>{item.title}</strong><span>{item.description}</span></span><Icon name="arrowRight" size={16}/>
      </Button>)}
    </div>
    <p className="mandala-welcome-hint">{hasDraft?l('先发送或清空当前草稿，再使用示例。','Send or clear your current draft to use an example.'):l('选择示例后可编辑，再由你发送。也可以直接输入。','Choose an example, edit it, then send. Or type your own request.')}</p>
    <div className="mandala-welcome-loop" role="note" aria-label={l('Mandala 如何工作','How Mandala works')}>
      <span>{l('说一次','Say it once')}</span><Icon name="arrowRight" size={12}/><span>{l('有人负责','an owner takes it')}</span><Icon name="arrowRight" size={12}/><span>{l('看它推进','watch it move')}</span><Icon name="arrowRight" size={12}/><span>{l('你来验收','you decide what is done')}</span>
      <small>{l('进展显示在右侧「任务」面板；完成由你确认，经验会沉淀为记忆。','Progress appears in the Tasks panel on the right. You confirm completion; lessons become memory.')}</small>
    </div>
  </section>;
}
