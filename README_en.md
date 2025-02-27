# Obsidian Task Processing Extension Plugin

[中文文档](https://github.com/odayou/task-processing-extension/blob/master/README.md)

> An [Obsidian](https://obsidian.md/) plugin for processing tasks.
>
> Developed based on the needs of my own work flow and [the demand of a friend on website](https://forum-zh.obsidian.md/t/topic/30252/4). Any suggestions are welcome.

## Repository

[odayou/obsidian-task-processing-extension](https://github.com/odayou/task-processing-extension)

## Features

1. Calculate the time spent on each task based on the recorded details (extract tasks from the current document).
2. Provide some quick commands, such as inserting pending/completed tasks, inserting the current time.
3. The above effects have corresponding commands and right-click menu.

## Usage

In the edit view, in the document that has tasks (standard task format) and time moments, call the command `total time` (or trigger it through the right-click menu), and the time spent on each task will be listed separately and the total time will be displayed

## Preview

- Time statistics effect display
![Time statistics demo](./screen/任务时间花费效果展示.png)
- Comprehensive demo
![Task processing demo](./screen/综合演示.gif)
- Quick commands demo
![Task quick editing demo](./screen/任务快捷编辑演示.gif)
- All features are integrated into the right-click menu
![right-click menu demo](./screen/快捷菜单示例.png)
  
## Demo

### Tasks

```markdown
- [ ] 10:21-10:30 task1 
    - [ ] 09:00-10:00 13:00-14:00 task1-1 #tag 
    - [ ] 15:00-16:10 17:00-18:20 task1-2 some English words and more 
- [x] 16:10-17:00 task2 #tag 
    - [ ] 10:00-13:00 19:00-20:20 tast2-2 
```

### Time statistics

```markdown
### 时间花费统计
---
task1: 0h 9m (0.15小时)
    task1-1 #tag: 2h 0m (2.00小时)
    task1-2 some English words and more: 2h 30m (2.50小时)
task2 #tag: 0h 50m (0.83小时)
    tast2-2: 4h 20m (4.33小时)

---
总时长: 9h 49m (9.82小时)
最后统计时间: 2025/2/27 22:15:22

---

```
