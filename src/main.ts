import './index.css';
import { bootstrap } from './app/bootstrap';

const root = document.getElementById('root');
if (!root) throw new Error('Kekenik Tree: #root element not found');
bootstrap(root);
