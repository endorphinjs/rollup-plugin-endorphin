import mountComponent from 'endorphin';
import MyApp from './src/my-app.html';

mountComponent('my-app', MyApp, document.body, { foo: 'bar' });