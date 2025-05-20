// 每次執行程式前需要先執行 ngrok http 3000 建立 public URL
// 並於 Slack App 的 Event Subscription verify Request URL 才能註冊 slack 事件處理器

// 流程：1. monday source board update posted 時，自動通知 slack channel
//      2. slack channel 監聽訊息並將資料處理後寫回 monday target board

// 當前版本可以成功將 source board 的 update 同步到 target board，但沒有辦法區分 update 跟 reply (因為兩者自動通知 slack channel 的訊息格式相同)
// source board 的 reply 會被視為 update 同步至 target board

import { createEventAdapter } from '@slack/events-api';
import express from 'express';
import axios from 'axios';
import 'dotenv/config';

const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
const mondayApiKey = process.env.MONDAY_API_KEY;

const app = express();
const slackEvents = createEventAdapter(slackSigningSecret); // 初始化 Slack 事件處理器

app.get('/', (req, res) => {
  res.status(200).send('slack-sync-update, server is running!');
});

// 綁定 slack 事件處理器到 /slack/events，需要接收未解析的原始請求體
app.use('/slack/events', slackEvents.requestListener());

// 監聽訊息事件
slackEvents.on('message', (event) => {
  console.log('Event: ', event);

  if (!event.bot_id) {
    console.log('[INFO] Message from a normal user');
    return;
  }
  if (event.bot_id && event.bot_id === process.env.SLACK_BOT_ID) {
    console.log('[INFO] Message from slack bot');

    if (event.channel_type === 'channel') {
      console.log(
        `New message in public channel ${event.channel} from user ${event.user}: ${event.text}`
      );
    } else if (event.channel_type === 'group') {
      console.log(
        `New message in private channel ${event.channel} from user ${event.user}: ${event.text}`
      );
    } else {
      console.log(
        `Message received in unknown channel type: ${event.channel_type}`
      );
    }

    // 抓取 Board Name 和 Item Name，後續 qeury Board B 的 itemId
    if (event.text) {
      console.log('Slack Event Text:', event.text);
      // const boardMatch = event.text.match(/on board (.+)/); // 抓取 Board Name
      // const itemMatch = event.text.match(/updated (.+) on board/); // 抓取 Item Name
      const boardMatch = event.text.match(/on\s+(.+?)\s+board/i); // 提取 Board Name
      const itemMatch = event.text.match(/updated\s+(.+?)\s+on\s+board/i); // 提取 Item Name

      // 提取 Board Name 和 Item Name
      // const boardMatch = event.text.match(/on\s+(.+)\s+board/i); // 提取 Board Name
      // const itemMatch = event.text.match(/updated\s+(.+)\s+on board/i); // 提取 Item Name
      console.log('boardMatch: ', boardMatch, ', itemMatch: ', itemMatch);

      if (!boardMatch || !itemMatch) {
        console.error(
          `Failed to parse Board or Item name from text: ${event.text}`
        );
        return;
      }

      const boardName = boardMatch[1];
      const itemName = itemMatch[1];
      const textBody = event.attachments[0].text;
      console.log(
        `Parsed Board Name: ${boardName}, Item Name: ${itemName}, textBody: ${textBody}`
      );

      // 查詢 Board B 並同步更新
      handleMondayUpdate(itemName, textBody);
    }
  }
});

// 處理錯誤
slackEvents.on('error', (error) => {
  console.error(`Error: ${error.message}`);
});

// 根據 source board 的 itemName 查詢 target Board 對應 Item 的 itemId
async function getItemId(targetBoardId, itemName) {
  const queryTargetBoard = `
    query{
      boards(ids: ${targetBoardId}) {
        items_page {
          items {
            id
            name
          }
        }
      }
    }
  `;

  try {
    const queryTargetResponse = await mondayOperate(queryTargetBoard);
    const targetItems = // target board 的所有 items
      queryTargetResponse.data?.data?.boards?.[0]?.items_page?.items || [];
    if (!targetItems.length) {
      console.error('[ERROR] No target items found in target board');
      return null;
    }
    console.log('target board items: ', targetItems);

    // 根據 source board 的 itemName 對應 target board 的 target item
    const targetItem = targetItems.find((item) => item.name === itemName);
    if (!targetItem) {
      console.error(`No matching item found in Board B for name: ${itemName}`);
      return null;
    }
    return targetItem.id; // 取得 target item 的 id
  } catch (error) {
    console.error('Error querying target Board: ', error);
    return null;
  }
}

// monday mutation: create_update
async function createUpdateInBoard(itemId, updateText) {
  const mutation = `
    mutation {
      create_update(
        item_id: ${itemId},
        body: "${updateText}"
      ) {
        id
      }
    }
  `;

  try {
    const response = await mondayOperate(mutation);
    console.log('Successfully created update in target Board: ', response.data);
  } catch (error) {
    console.error('Error creating update in target Board: ', error);
  }
}

// monday query / mutation
async function mondayOperate(method) {
  return await axios.post(
    'https://api.monday.com/v2',
    { query: method },
    { headers: { Authorization: mondayApiKey } }
  );
}

// 處理 Monday 更新邏輯
async function handleMondayUpdate(itemName, updateText) {
  const targetBoardId = process.env.TARGET_BOARD_ID; // target Board ID
  const targetItemId = await getItemId(targetBoardId, itemName);

  if (targetItemId) {
    await createUpdateInBoard(targetItemId, updateText);
  }
}

// 將 value 轉換成 GraphQL JSON string，用於 change column value
function escapeForGraphQL(value) {
  return JSON.stringify(value).replace(/"/g, '\\"');
}

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(
    `Server is running and listening for Slack events on http://localhost:${PORT}`
  );
});
